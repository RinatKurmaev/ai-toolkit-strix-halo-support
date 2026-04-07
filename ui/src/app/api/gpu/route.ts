import { NextResponse } from 'next/server';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import os from 'os';
import * as fs from 'fs';

const execAsync = promisify(exec);

interface MacGpuResult {
  name: string;
  memUsed: number;
  memTotal: number;
  gpuLoad: number;
  temperature: number;
  fanSpeed: number;
  powerDraw: number;
}

async function getMacGpuInfo(): Promise<MacGpuResult | null> {
  try {
    const memoryTotal = os.totalmem() / (1024 * 1024);

    // Get GPU name and core count from system_profiler
    let gpuName = 'Apple GPU';
    try {
      const spOut = execSync(
        'system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model|Total Number of Cores"',
        { encoding: 'utf-8', timeout: 5000 },
      );
      const nameMatch = spOut.match(/Chipset Model:\s*(.+)/);
      const coresMatch = spOut.match(/Total Number of Cores:\s*(\d+)/);
      if (nameMatch) {
        gpuName = nameMatch[1].trim();
        if (coresMatch) {
          gpuName += ` GPU (${coresMatch[1]} cores)`;
        }
      }
    } catch {
      // fallback to generic name
    }

    let temperature = 0;
    let gpuLoad = 0;
    let fanSpeed = 0;
    let powerDraw = 0;
    let memUsed = 0;
    let memTotal = memoryTotal;

    try {
      // Use createRequire to hide from webpack static analysis so it doesn't fail on non-mac platforms
      const nativeRequire = createRequire(import.meta.url);
      const ms = nativeRequire('macstats') as any;

      try {
        const gpuData = ms.getGpuDataSync();
        temperature = gpuData.temperature || 0;
        gpuLoad = gpuData.usage || 0;
      } catch {
        // ignore
      }

      try {
        const fanData = ms.getFanDataSync();
        const fanKeys = Object.keys(fanData);
        if (fanKeys.length > 0) {
          fanSpeed = fanData[fanKeys[0]].rpm || 0;
        }
      } catch {
        // ignore
      }

      try {
        const powerData = ms.getPowerDataSync();
        powerDraw = powerData.gpu || 0;
      } catch {
        // ignore
      }

      try {
        const ramData = ms.getRAMUsageSync();
        memUsed = ramData.used / (1024 * 1024);
        memTotal = ramData.total / (1024 * 1024);
      } catch {
        // ignore
      }
    } catch (error) {
      console.warn('macstats not available:', error);
    }

    return { name: gpuName, memUsed, memTotal, gpuLoad, temperature, fanSpeed, powerDraw };
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    // Get platform
    const platform = os.platform();
    const isWindows = platform === 'win32';
    const isMac = platform === 'darwin';

    if (isMac) {
      const macGpu = await getMacGpuInfo();
      if (macGpu) {
        return NextResponse.json({
          hasNvidiaSmi: false,
          isMac: true,
          gpus: [
            {
              index: 0,
              name: macGpu.name,
              driverVersion: 'macOS',
              temperature: Math.round(macGpu.temperature),
              utilization: {
                gpu: macGpu.gpuLoad,
                memory: macGpu.memTotal > 0 ? Math.round((macGpu.memUsed / macGpu.memTotal) * 100) : 0,
              },
              memory: {
                total: Math.round(macGpu.memTotal),
                free: Math.round(macGpu.memTotal - macGpu.memUsed),
                used: Math.round(macGpu.memUsed),
              },
              power: { draw: macGpu.powerDraw, limit: 0 },
              clocks: { graphics: 0, memory: 0 },
              fan: { speed: macGpu.fanSpeed },
            },
          ],
        });
      }
      return NextResponse.json({
        hasNvidiaSmi: false,
        isMac: true,
        gpus: [],
        error: 'Could not read Mac GPU stats',
      });
    }

    // Check if nvidia-smi or amd-smi is available
    const hasNvidiaSmi = await checkNvidiaSmi(isWindows);
    const hasAmdSmi = await checkAMDSmi(isWindows);
    if (!hasNvidiaSmi && !hasAmdSmi) {
      return NextResponse.json({
        hasNvidiaSmi: false,
        isMac: false,
        gpus: [],
        error: 'nvidia-smi or amd-smi not found or not accessible',
      });
    }

    // Get GPU stats
    if (hasNvidiaSmi) {
      const gpuStats = await getGpuStats(isWindows);
      return NextResponse.json({
        hasNvidiaSmi: true,
        gpus: gpuStats,
      });
    } 
    if(hasAmdSmi) {
      const gpuStats = await getAMDGpuStats(isWindows);
      return NextResponse.json({
        hasNvidiaSmi: true,
        gpus: gpuStats,
      });
    };
  } catch (error) {
    console.error('Error fetching GPU stats:', error);
    return NextResponse.json(
      {
        hasNvidiaSmi: false,
        isMac: false,
        gpus: [],
        error: `Failed to fetch GPU stats: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}

async function checkNvidiaSmi(isWindows: boolean): Promise<boolean> {
  try {
    if (isWindows) {
      // Check if nvidia-smi is available on Windows
      // It's typically located in C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe
      // but we'll just try to run it directly as it may be in PATH
      await execAsync('nvidia-smi -L');
    } else {
      // Linux/macOS check
      await execAsync('which nvidia-smi');
    }
    return true;
  } catch (error) {
    return false;
  }
}
async function checkAMDSmi(isWindows: boolean): Promise<boolean> {
  try {
    if (!isWindows) {
      // Linux/macOS check
      await execAsync('which amd-smi');
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function getGpuStats(isWindows: boolean) {
  // Command is the same for both platforms, but the path might be different
  const command =
    'nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,fan.speed --format=csv,noheader,nounits';

  // Execute command
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });

  // Parse CSV output
  const gpus = stdout
    .trim()
    .split('\n')
    .map(line => {
      const [
        index,
        name,
        driverVersion,
        temperature,
        gpuUtil,
        memoryUtil,
        memoryTotal,
        memoryFree,
        memoryUsed,
        powerDraw,
        powerLimit,
        clockGraphics,
        clockMemory,
        fanSpeed,
      ] = line.split(', ').map(item => item.trim());

      return {
        index: parseInt(index),
        name,
        driverVersion,
        temperature: parseInt(temperature),
        utilization: {
          gpu: parseInt(gpuUtil),
          memory: parseInt(memoryUtil),
        },
        memory: {
          total: parseInt(memoryTotal),
          free: parseInt(memoryFree),
          used: parseInt(memoryUsed),
        },
        power: {
          draw: parseFloat(powerDraw),
          limit: parseFloat(powerLimit),
        },
        clocks: {
          graphics: parseInt(clockGraphics),
          memory: parseInt(clockMemory),
        },
        fan: {
          speed: parseInt(fanSpeed) || 0, // Some GPUs might not report fan speed, default to 0
        },
      };
    });

  return gpus;
}

async function getAMDGpuStats(isWindows: boolean) {
  const command = 'amd-smi static --json && echo ";" && amd-smi metric --json';
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });
  var data = stdout.split(';');

  var sdata = {};
  var mdata = {};
  try {
      sdata = JSON.parse(data[0]);
      mdata = JSON.parse(data[1]);
  } catch (error) {
    return [];
  }

  var gpus = sdata["gpu_data"].map(d => {
    const i = amdParseInt(d["gpu"]);
    const gpu_data = mdata["gpu_data"][i];
    const mem_total = amdParseFloat(gpu_data["mem_usage"]["total_vram"]["value"]);
    const mem_used =  amdParseFloat(gpu_data["mem_usage"]["used_vram"]["value"]);
    const mem_free =  amdParseFloat(gpu_data["mem_usage"]["free_visible_vram"]["value"]);
    const mem_utilization = ((1.0 - (mem_total - mem_free)) / mem_total) * 100;

    try {
      var temperature = amdParseInt(gpu_data["temperature"]["hotspot"]["value"]);
      mdata = JSON.parse(data[1]);
  } catch (error) {
    console.log(error);
    temperature = NaN;
  }
  if (isNaN(temperature))
  {
      try {
        //fall back to reading from /sys/class/ec_su_axb35/temp1/temp
        // This function dependant on this module
        // https://github.com/cmetz/ec-su_axb35-linux
        // Works only on certain strix halo boards
        var raw_data = fs.readFileSync('/sys/class/ec_su_axb35/temp1/temp', 'utf-8');
      var temperature = amdParseInt(raw_data);

        } catch (error) {
         var temperature = NaN;
      }
  }
    var speed = gpu_data["fan"]["usage"]["value"];
    if (isNaN(speed))
      {
      try {
        //console.log('fall back to reading from /sys/class/ec_su_axb35/fanX/rpm')
        var raw_data = fs.readFileSync('/sys/class/ec_su_axb35/fan1/rpm', 'utf-8');
        raw_data +=', ';
        raw_data += fs.readFileSync('/sys/class/ec_su_axb35/fan2/rpm', 'utf-8');
        raw_data +=', ';
        raw_data += fs.readFileSync('/sys/class/ec_su_axb35/fan3/rpm', 'utf-8');
        var speed = raw_data;
        } catch (error) {
         var speed = NaN;
      }
  }
    try {
        var gpu_usage = gpu_data["usage"]["gfx_activity"]["value"];
    }  catch (error) {
         var gpu_usage = NaN;
      }

    return {
      index: i,
      name: d["asic"]["market_name"],
      driverVersion: d["driver"]["version"],
      temperature: temperature,
      utilization: {
        gpu: gpu_usage,
        memory: mem_utilization,
      },
      memory: {
        total: mem_total,
        used:  mem_used,
        free:  mem_free,
      },
      power: {
        draw: amdParseFloat(gpu_data["power"]["socket_power"]["value"]),
        limit: amdParseFloat(() => {
	  try {
	    if (d["limit"]["max_power"]) {
	      return d["limit"]["max_power"]["value"];
	    } else if (d["limit"]["ppt0"]["max_power_limit"]["value"]) {
	      return d["limit"]["ppt0"]["max_power_limit"]["value"];
	    }
	  } catch (error) {
	    return 0.0;
	  }
	})
      },
      clocks: {
        graphics: amdParseInt(gpu_data["clock"]["gfx_0"]["clk"]["value"]),
        memory: amdParseInt(gpu_data["clock"]["mem_0"]["clk"]["value"]),
      },
      fan: {
        speed: speed,
      }
    };
  });

  return gpus;
}

function amdParseFloat(value) {
    try {
        const ret = parseFloat(value);
        return ret;
    } catch(error) {
        return 0.0;
    }
}

function amdParseInt(value) {
    try {
        const ret = parseInt(value);
        return ret;
    } catch(error) {
        return 0;
    }
}
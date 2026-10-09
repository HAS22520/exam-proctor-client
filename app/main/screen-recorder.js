const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ScreenRecorder {
  constructor(config) {
    this.config = config.recording || {};
    this.outputDir = path.resolve(this.config.outputDir || './records');
    this.ffmpegProcess = null;
    this.isRecording = false;
    this.currentOutputFile = null;

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  // 寻找 FFmpeg 执行文件路径 (优先打包 extraResources，其次项目内 bin/ffmpeg.exe，再次 npm 内置 ffmpeg-static，最后系统环境变量 ffmpeg)
  resolveFfmpegPath() {
    if (process.resourcesPath) {
      const packagedFfmpeg = path.join(process.resourcesPath, 'bin/ffmpeg.exe');
      if (fs.existsSync(packagedFfmpeg)) return packagedFfmpeg;
    }
    const localFfmpeg = path.resolve(__dirname, '../../bin/ffmpeg.exe');
    if (fs.existsSync(localFfmpeg)) {
      return localFfmpeg;
    }
    try {
      const staticFfmpeg = require('ffmpeg-static');
      if (staticFfmpeg && fs.existsSync(staticFfmpeg)) {
        return staticFfmpeg;
      }
    } catch (e) {}
    return 'ffmpeg';
  }

  start() {
    if (this.isRecording) {
      console.warn('[ScreenRecorder] [WARN] 录制已在进行中');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.currentOutputFile = path.join(this.outputDir, `exam_${timestamp}.${this.config.videoFormat || 'mp4'}`);

    const ffmpegPath = this.resolveFfmpegPath();
    const fps = this.config.fps || 15;

    // Windows 平台使用 gdigrab 采集桌面
    const args = [
      '-y',
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-draw_mouse', this.config.captureMouse ? '1' : '0',
      '-i', 'desktop',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      this.currentOutputFile
    ];

    console.log(`[ScreenRecorder] [INFO] 启动屏幕录制，输出目标: ${this.currentOutputFile}`);

    try {
      this.ffmpegProcess = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.isRecording = true;

      this.ffmpegProcess.stderr.on('data', (data) => {
        // 遇到错误时可输出
      });

      this.ffmpegProcess.on('error', (err) => {
        console.error('[ScreenRecorder] [ERROR] FFmpeg 启动失败 (未检测到 ffmpeg 二进制文件或无执行权限):', err.message);
        console.info('[ScreenRecorder] [INFO] 建议：将 ffmpeg.exe 放置于 bin/ 目录下，或使用系统级 FFmpeg。');
        this.isRecording = false;
      });

      this.ffmpegProcess.on('close', (code) => {
        console.log(`[ScreenRecorder] [INFO] 录制进程已退出，退出码: ${code}`);
        this.isRecording = false;
      });
    } catch (err) {
      console.error('[ScreenRecorder] [ERROR] 无法启动录屏进程:', err);
    }
  }

  stop() {
    if (!this.isRecording || !this.ffmpegProcess) {
      return Promise.resolve();
    }

    console.log('[ScreenRecorder] [INFO] 正在停止录屏并保存文件...');
    return new Promise((resolve) => {
      // 向 ffmpeg 的 stdin 发送 'q' 进行优雅退出，保证 mp4 文件元数据(moov atom)完整
      try {
        this.ffmpegProcess.stdin.write('q');
      } catch (e) {
        this.ffmpegProcess.kill('SIGINT');
      }

      this.ffmpegProcess.on('close', () => {
        this.isRecording = false;
        console.log(`[ScreenRecorder] [INFO] 录屏已安全保存至: ${this.currentOutputFile}`);
        resolve(this.currentOutputFile);
      });

      // 超时保底
      setTimeout(() => {
        if (this.isRecording) {
          this.ffmpegProcess.kill('SIGKILL');
          this.isRecording = false;
          resolve(this.currentOutputFile);
        }
      }, 5000);
    });
  }
}

module.exports = ScreenRecorder;

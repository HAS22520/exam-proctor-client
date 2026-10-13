import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

/** 从同一份矢量源生成 PNG、Windows 多尺寸 ICO 和 macOS ICNS，无需平台工具。 */
export function generateIcons(root: string, output: string) {
    const svg = fs.readFileSync(path.join(root, 'app/renderer/assets/icon.svg'), 'utf8');
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
    const png = new Map(sizes.map((size) => [size, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()]));
    const icons = path.join(output, 'icons');
    fs.mkdirSync(icons, { recursive: true });
    fs.writeFileSync(path.join(output, 'app/renderer/assets/icon.png'), png.get(256)!);
    const windows = sizes.filter((size) => size <= 256);
    const header = Buffer.alloc(6 + windows.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(windows.length, 4);
    let offset = header.length;
    for (const [index, size] of windows.entries()) {
        const entry = 6 + index * 16;
        const data = png.get(size)!;
        header[entry] = size === 256 ? 0 : size;
        header[entry + 1] = size === 256 ? 0 : size;
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(data.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += data.length;
    }
    fs.writeFileSync(path.join(icons, 'icon.ico'), Buffer.concat([header, ...windows.map((size) => png.get(size)!)]));
    const apple = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]] as const;
    const chunks = apple.map(([type, size]) => {
        const data = png.get(size)!;
        const chunk = Buffer.alloc(8);
        chunk.write(type);
        chunk.writeUInt32BE(8 + data.length, 4);
        return Buffer.concat([chunk, data]);
    });
    const prefix = Buffer.alloc(8);
    prefix.write('icns');
    prefix.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    fs.writeFileSync(path.join(icons, 'icon.icns'), Buffer.concat([prefix, ...chunks]));
}

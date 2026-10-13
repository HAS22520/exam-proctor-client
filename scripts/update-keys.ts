import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRoot } from './project-layout';

function run(args = process.argv.slice(2)) {
    if (args.length !== 2 || args[0] !== '--out-dir' || !args[1].trim()) {
        throw new Error('用法：npm run keys:update -- --out-dir <仓库外的私钥目录>');
    }
    const directory = path.resolve(args[1]);
    const privateFile = path.join(directory, 'update-private.pem');
    const publicFile = path.join(directory, 'update-public.pem');
    const relative = path.relative(projectRoot, directory);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
        throw new Error('更新签名密钥必须存放在客户端仓库之外');
    }
    if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) {
        throw new Error('更新密钥文件已存在，请复用，不要覆盖已有发布信任密钥');
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keys = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(publicFile, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
    return { privateFile, publicFile };
}
if (require.main === module) {
    try {
        console.log(JSON.stringify(run()));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
export { run };

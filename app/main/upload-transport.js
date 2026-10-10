const fs = require('node:fs');
const crypto = require('node:crypto');
const { ProctorError, parseReply } = require('./proctor-auth');

async function uploadFile({ session, origin, path, filename, uploadName, headers, onProgress, timeoutMs = 120000,
  createRequest = (options) => require('electron').net.request(options) }) {
  const url = new URL(path, origin);
  if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//') || !/^proctor-[a-f0-9]{24}\.hplog$/.test(uploadName)) throw new Error('Invalid log upload target');
  const boundary = `HydroProctor${crypto.randomBytes(24).toString('hex')}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operation"\r\n\r\nupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${uploadName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const total = prefix.length + fs.statSync(filename).size + suffix.length;
  const request = createRequest({ url: url.href, method: 'POST', session, useSessionCookies: true, redirect: 'manual' });
  request.chunkedEncoding = true;
  for (const [key, value] of Object.entries({ Accept: 'application/json', Origin: origin,
    'Content-Type': `multipart/form-data; boundary=${boundary}`, ...headers })) request.setHeader(key, value);
  let ended = false, responseStarted = false, sent = 0, input;
  return new Promise((resolve, reject) => {
    const progress = () => {
      if (ended) return;
      let value;
      try { value = request.getUploadProgress(); }
      catch { fail(new ProctorError('Cannot read log upload progress')); return; }
      if (!value.active || !value.started) return;
      sent = Math.max(sent, Math.min(total, value.current));
      onProgress?.({ sent, total, percent: Math.floor(sent / total * 100), phase: responseStarted || sent === total ? 'verifying' : 'uploading' });
    };
    const poll = setInterval(progress, 200);
    const timeout = setTimeout(() => fail(new ProctorError('Log upload timed out')), timeoutMs);
    const finish = (error, result) => {
      if (ended) return;
      ended = true; clearInterval(poll); clearTimeout(timeout); input?.destroy();
      if (error) reject(error); else resolve(result);
    };
    const fail = (error) => { if (ended) return; finish(error); request.abort(); };
    request.on('error', (error) => fail(new ProctorError(error.message)));
    request.on('abort', () => finish(new ProctorError('Log upload aborted')));
    request.on('close', () => { if (!ended) finish(new ProctorError('Log upload response lost')); });
    request.on('redirect', () => fail(new ProctorError('Log upload redirects are forbidden', 403)));
    request.on('response', (response) => {
      if (ended) return;
      responseStarted = true;
      progress(); onProgress?.({ phase: 'verifying', sent, total, percent: Math.floor(sent / total * 100) });
      const chunks = []; let size = 0;
      response.on('error', (error) => fail(new ProctorError(error.message)));
      response.on('aborted', () => fail(new ProctorError('Log upload response lost')));
      response.on('data', (chunk) => {
        if (ended) return;
        size += chunk.length;
        if (size > 1024 * 1024) { fail(new ProctorError('Protocol response too large', 400)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (ended) return;
        try { finish(null, parseReply(Buffer.concat(chunks).toString('utf8'), response.statusCode,
          (response.headers['content-type'] || []).join(';'))); }
        catch (error) { finish(error); }
      });
    });
    (async () => {
      const write = (chunk) => new Promise((done) => request.write(chunk, 'utf8', done));
      await write(prefix);
      if (ended) return;
      input = fs.createReadStream(filename);
      for await (const chunk of input) { if (ended) return; await write(chunk); }
      if (!ended) request.end(suffix);
    })().catch(fail);
  });
}

module.exports = { uploadFile };

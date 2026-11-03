import { createWorker, OEM } from 'tesseract.js';

let worker;

try {
  const input = JSON.parse(await readStdin());
  if (!input.image || !input.cache || !input.languages) {
    throw new Error('OCR input needs image, cache, and languages.');
  }

  const cachePath = input.cache;
  const languages = String(input.languages).split('+').map((language) => language.trim()).filter(Boolean);
  worker = await createWorker(languages, OEM.LSTM_ONLY, { cachePath, cacheMethod: 'write' });
  const recognition = await worker.recognize(input.image);
  process.stdout.write(JSON.stringify({ text: recognition.data.text ?? '' }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (worker) await worker.terminate();
}

async function readStdin() {
  let stdinText = '';
  for await (const chunk of process.stdin) stdinText += chunk;
  return stdinText;
}

import { parentPort, workerData } from 'node:worker_threads';
import { PDFDocument } from 'pdf-lib';

// Parsing untrusted bytes is isolated from the HTTP event loop and bounded by the caller.
try {
  const pdf = await PDFDocument.load(workerData, { updateMetadata: false });
  parentPort.postMessage(pdf.getPageCount() > 0 && pdf.getPageCount() <= 100);
} catch {
  parentPort.postMessage(false);
}

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicDemo } from './public-demo.ts';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedOrigins = (process.env.EIR_PUBLIC_ORIGINS ?? '')
  .split(',')
  .filter(Boolean)
  .map((origin) => {
    z.url({ protocol: /^https$/ }).parse(origin);
    if (new URL(origin).origin !== origin)
      throw new Error('Public origins must not include a path');
    return origin;
  });
const app = await createPublicDemo(root, { allowedOrigins });
const address = await app.listen({
  port: Number(process.env.PORT ?? 4181),
  host: process.env.HOST ?? '127.0.0.1',
});
console.log(`Eir EHR public synthetic demo: ${address}`);
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { Runtime } from '../packages/runtime.ts';
import ollama from '../plugins/ai-ollama.ts';
const model = process.argv[2];
if (!model) throw new Error('Pass an installed Ollama model name');
const runtime = await new Runtime().start([{ plugin: ollama, config: { model } }]);
try {
  const evidence = [
    { ref: 'synthetic-encounter@1', text: 'Syntetiskt test: återbesök för uppföljning.' },
    { ref: 'synthetic-observation@1', text: 'Syntetiskt test: puls 72 /min.' },
  ];
  const output = await runtime.get('aiProvider').generate(evidence);
  if (
    !output.citations.every((c) => evidence.some((e) => e.ref === c.ref && e.text.includes(c.text)))
  )
    throw new Error('Invalid citation from live model');
  console.log(JSON.stringify(output, null, 2));
} finally {
  runtime.stop();
}

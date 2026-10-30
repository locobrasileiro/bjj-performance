// Reduce exercises.json (10 idiomas) a un catálogo compacto en español:
// [id, nombre(en), zona, equipo, músculo, secundarios, pasos(es) separados por |, imagen, gif]
import fs from 'node:fs';
import path from 'node:path';
const [src, dst] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const out = d.map((x) => [
  x.id, x.name, x.body_part, x.equipment, x.target,
  (x.secondary_muscles || []).join(', '),
  (x.instruction_steps?.es || x.instruction_steps?.en || []).join('|'),
  path.basename(x.image), path.basename(x.gif_url),
]);
fs.writeFileSync(dst, JSON.stringify(out));
console.log(`${out.length} ejercicios -> ${dst}`);

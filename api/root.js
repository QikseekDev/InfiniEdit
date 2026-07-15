import fs from 'fs';
import path from 'path';

const markdown = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf-8');

export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(markdown);
}

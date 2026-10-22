// Runs lib/deko3d_glsl.js (the page's SPIRV-Cross GLSL -> uam GLSL -> optimised GLSL) on the *.vk.glsl of a folder
// and compares it byte for byte with peggle2-nx's Python tools on the same input: tools/deko3d_glsl.py's convert() as
// tools/deko3d_shaders.py calls it (its out/deko3d_shaders/glsl), then tools/deko3d_glsl_opt.py's main() (glsl_opt).
// The Python references are made fresh into a scratch folder (python -P, several processes).
//
// Usage: node test/deko3d_glsl_node.mjs [<vk folder>] [--sample N] [--lists <folder>] [--work <folder>]
//                                       [--tools <folder>] [--python <exe>] [--jobs N] [--reuse]
//   <vk folder>  default ../peggle1-nx/out/deko3d_shaders/vk (only read)
//   --sample N   N shaders spread evenly over the sorted names (default: all of them)
//   --lists      a folder with gpr32_shaders.txt / lightbranch_shaders.txt / nullps_shaders.txt that both sides use
//                (peggle2-nx has none, so those passes change nothing; another port's lists exercise them)
//   --work       default ../installer_work/deko3d_glsl_test/<corpus>[_sampleN][_lists] (corpus: the folder 3 up)
//   --tools      the Python tools (default ../peggle1-nx/tools); --python the interpreter (default python), run
//                as `python -P -B` in --jobs processes (default: the CPU count less 2, at most 16)
//   --reuse      compare with the references already in --work (no Python run)
// Exit status 1 when a shader differs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Unsupported, deko3dShader } from '../lib/deko3d_glsl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? Boolean(args.splice(at, 1)) : false;
};
const sample = Number(option('--sample', '0'));
const listsDir = option('--lists', '');
const tools = path.resolve(option('--tools', path.join(root, '..', 'peggle1-nx', 'tools')));
const python = option('--python', 'python');
const jobs = Number(option('--jobs', String(Math.max(1, Math.min(os.availableParallelism() - 2, 16)))));
const reuse = flag('--reuse');
const workOption = option('--work', '');
const [folderArg = path.join(root, '..', 'peggle1-nx', 'out', 'deko3d_shaders', 'vk')] = args;
const folder = path.resolve(folderArg);
const corpus = path.basename(path.resolve(folder, '..', '..', '..'));
const work = path.resolve(workOption || path.join(root, '..', 'installer_work', 'deko3d_glsl_test',
  `${corpus}${sample ? `_sample${sample}` : ''}${listsDir ? '_lists' : ''}`));

const all = fs.readdirSync(folder).filter((n) => n.endsWith('.vk.glsl')).sort();
let names = all;
if (sample && sample < all.length) {
  names = Array.from({ length: sample }, (_, k) => all[Math.floor((k * all.length) / sample)]);
}
console.log(`${folder}: ${names.length} shaders${names.length < all.length ? ` (a sample of ${all.length})` : ''}`);

// The Python side: tools/deko3d_shaders.py's convert call for each shader, then tools/deko3d_glsl_opt.py's main()
// over the chunk's outputs (with the lists given, set where the module keeps them).
const DRIVER = String.raw`import json, os, re, shutil, sys
tools, src, names_file, work, chunk, lists = sys.argv[1:7]
sys.path.insert(0, tools)
import deko3d_glsl
import deko3d_glsl_opt
if lists:
    deko3d_glsl_opt.GPR32_LIST = os.path.join(lists, 'gpr32_shaders.txt')
    deko3d_glsl_opt._GPR32 = None
    deko3d_glsl_opt._LB_LIST_PATH = os.path.join(lists, 'lightbranch_shaders.txt')
    deko3d_glsl_opt._LIGHTBRANCH = deko3d_glsl_opt._lb_list()
    deko3d_glsl_opt._NULLPS_LIST_PATH = os.path.join(lists, 'nullps_shaders.txt')
    deko3d_glsl_opt._NULLPS = deko3d_glsl_opt._nullps_list()
names = [n for n in open(names_file, encoding='utf-8').read().split('\n') if n]
in_dir = os.path.join(work, 'chunk_' + chunk)
os.makedirs(in_dir, exist_ok=True)
errors = {}
for n in names:
    stem = n[:-len('.vk.glsl')]
    stage = 'frag' if stem.startswith('ps_') else 'vert'
    try:  # tools/deko3d_shaders.py one()
        with open(os.path.join(src, n), encoding='utf-8') as f:
            vk = f.read()
        text, _ = deko3d_glsl.convert(vk, stage, deko3d_glsl.DEFAULT_UBO_MAP, 'handle')
    except deko3d_glsl.Unsupported as e:
        errors[stem] = 'Unsupported: ' + str(e)
        continue
    except Exception as e:
        errors[stem] = 'error: ' + type(e).__name__ + ': ' + str(e)
        continue
    for d in (os.path.join(work, 'glsl'), in_dir):
        with open(os.path.join(d, stem + '.glsl'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
opt_errors = {}
sys.argv = ['deko3d_glsl_opt.py', '--in', in_dir, '--out', os.path.join(work, 'glsl_opt')]
try:
    deko3d_glsl_opt.main()
except Exception:
    # main() stops at a shader that raises: its loop again one shader at a time, the failures recorded
    for name in sorted(os.listdir(in_dir)):
        if not re.fullmatch(r'(vs|ps)_[0-9A-F]{16}\.glsl', name):
            continue
        try:
            with open(os.path.join(in_dir, name), encoding='utf-8') as f:
                out = deko3d_glsl_opt.optimise(f.read(), deko3d_glsl_opt.DEFAULT,
                                               'frag' if name.startswith('ps_') else 'vert', name[3:19])
        except Exception as e:
            opt_errors[name[:-5]] = 'error: ' + type(e).__name__ + ': ' + str(e)
            continue
        with open(os.path.join(work, 'glsl_opt', name), 'w', encoding='utf-8', newline='\n') as f:
            f.write(out)
with open(os.path.join(work, 'errors_' + chunk + '.json'), 'w', encoding='utf-8') as f:
    json.dump({'convert': errors, 'optimise': opt_errors}, f)
shutil.rmtree(in_dir)
`;

function run(exe, argv) {
  return new Promise((resolve) => {
    const child = spawn(exe, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0', PYTHONIOENCODING: 'utf-8' },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

let started = Date.now();
if (!reuse) {
  fs.mkdirSync(work, { recursive: true });
  for (const name of fs.readdirSync(work)) {
    if (['glsl', 'glsl_opt'].includes(name) || /^(chunk_\d+|errors_\d+\.json|names_\d+\.txt)$/.test(name)) {
      fs.rmSync(path.join(work, name), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.join(work, 'glsl'));
  fs.mkdirSync(path.join(work, 'glsl_opt'));
  const driver = path.join(work, 'py_reference.py');
  fs.writeFileSync(driver, DRIVER);
  const chunks = Array.from({ length: Math.min(jobs, names.length) }, () => []);
  names.forEach((n, k) => chunks[k % chunks.length].push(n));
  const results = await Promise.all(chunks.map((chunk, k) => {
    const list = path.join(work, `names_${k}.txt`);
    fs.writeFileSync(list, `${chunk.join('\n')}\n`);
    return run(python, ['-P', '-B', driver, tools, folder, list, work, String(k), listsDir ? path.resolve(listsDir) : '']);
  }));
  for (const [k, r] of results.entries()) {
    if (r.code !== 0) {
      throw new Error(`Python chunk ${k} failed (${r.code}):\n${r.output}`);
    }
  }
  console.log(`Python references: ${work} (${((Date.now() - started) / 1000).toFixed(1)} s, ${chunks.length} processes)`);
} else {
  console.log(`Python references: ${work} (reused)`);
}
const pyErrors = { convert: {}, optimise: {} };
for (const name of fs.readdirSync(work).filter((n) => /^errors_\d+\.json$/.test(n))) {
  const e = JSON.parse(fs.readFileSync(path.join(work, name), 'utf8'));
  Object.assign(pyErrors.convert, e.convert);
  Object.assign(pyErrors.optimise, e.optimise);
}

const lists = {};
if (listsDir) {
  for (const kind of ['gpr32', 'lightbranch', 'nullps']) {
    const p = path.join(listsDir, `${kind}_shaders.txt`);
    lists[kind] = fs.existsSync(p) ? fs.readFileSync(p) : [];
  }
}

const readOrNull = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const errorText = (e) => (e instanceof Unsupported ? `Unsupported: ${e.message}` : `error: ${e.name}: ${e.message}`);

// a side's result: { text } or { error }
function compare(stage, stem, py, js, tally, diffs) {
  if (py.error !== undefined || js.error !== undefined) {
    const same = py.error !== undefined && js.error !== undefined &&
      (py.error === js.error || (!py.error.startsWith('Unsupported') && !js.error.startsWith('Unsupported')));
    if (same) {
      tally.failedBoth++;
    } else {
      tally.different++;
      diffs.push({ stage, stem, py: py.error ?? '(output)', js: js.error ?? '(output)' });
    }
    return;
  }
  const jsBytes = Buffer.from(js.text, 'utf8');
  if (jsBytes.equals(py.text)) {
    tally.identical++;
    return;
  }
  tally.different++;
  const a = py.text.toString('utf8').split('\n');
  const b = js.text.split('\n');
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) {
    line++;
  }
  diffs.push({ stage, stem, line: line + 1, py: a[line] ?? '(end)', js: b[line] ?? '(end)' });
}

const tallies = {
  convert: { identical: 0, different: 0, failedBoth: 0 },
  optimise: { identical: 0, different: 0, failedBoth: 0, skipped: 0 },
};
const diffs = [];
started = Date.now();
let jsTime = 0;
for (const name of names) {
  const stem = name.slice(0, -'.vk.glsl'.length);
  const vk = fs.readFileSync(path.join(folder, name));
  let js;
  const t0 = performance.now();
  try {
    js = deko3dShader(stem, vk, { lists });
  } catch (e) {
    js = { error: errorText(e) };
  }
  jsTime += performance.now() - t0;
  const pyConvert = pyErrors.convert[stem] !== undefined ? { error: pyErrors.convert[stem] } :
    { text: readOrNull(path.join(work, 'glsl', `${stem}.glsl`)) };
  if (pyConvert.text === null) {
    throw new Error(`no Python output for ${stem}`);
  }
  compare('convert', stem, pyConvert, js.error !== undefined ? js : { text: js.glsl }, tallies.convert, diffs);
  if (pyConvert.error !== undefined && js.error !== undefined) {
    tallies.optimise.skipped++;
    continue;
  }
  const pyOptText = readOrNull(path.join(work, 'glsl_opt', `${stem}.glsl`));
  const pyOpt = pyErrors.optimise[stem] !== undefined ? { error: pyErrors.optimise[stem] } :
    pyOptText !== null ? { text: pyOptText } : pyConvert.error !== undefined ? { error: pyConvert.error } : null;
  const jsOpt = js.error !== undefined ? js : js.opt !== null ? { text: js.opt } : null;
  if (pyOpt === null && jsOpt === null) {
    tallies.optimise.skipped++; // a name the optimiser does not take, on both sides
    continue;
  }
  compare('optimise', stem, pyOpt ?? { error: '(no output)' }, jsOpt ?? { error: '(no output)' }, tallies.optimise,
    diffs);
}

const show = (t) => `${t.identical} identical, ${t.different} different` +
  `${t.failedBoth ? `, ${t.failedBoth} failed on both sides alike` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}`;
console.log(`convert (deko3d_glsl.py):       ${show(tallies.convert)}`);
console.log(`optimise (deko3d_glsl_opt.py):  ${show(tallies.optimise)}`);
console.log(`JS: ${(jsTime / 1000).toFixed(2)} s for ${names.length} shaders (convert + optimise)`);
for (const d of diffs.slice(0, 8)) {
  const cut = (s) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);
  console.log(`  ${d.stage} ${d.stem}${d.line ? ` line ${d.line}` : ''}:\n    python: ${cut(d.py)}\n    js:     ${cut(d.js)}`);
}
if (diffs.length > 8) {
  console.log(`  ... and ${diffs.length - 8} more`);
}

// The outputs already next to the corpus (made by whichever tools that tree has): for information only.
for (const sub of ['glsl', 'glsl_opt']) {
  const dir = path.join(folder, '..', sub);
  if (!fs.existsSync(dir) || listsDir) {
    continue;
  }
  let same = 0;
  let there = 0;
  for (const name of names) {
    const ref = readOrNull(path.join(work, sub, `${name.slice(0, -'.vk.glsl'.length)}.glsl`));
    const old = readOrNull(path.join(dir, `${name.slice(0, -'.vk.glsl'.length)}.glsl`));
    if (ref !== null && old !== null) {
      there++;
      same += ref.equals(old) ? 1 : 0;
    }
  }
  console.log(`(info) ${path.resolve(dir)}: ${same} of ${there} identical to the fresh Python references`);
}
process.exitCode = tallies.convert.different || tallies.optimise.different ? 1 : 0;

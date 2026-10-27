/* Build: ESM source -> IIFE global + minified copies. Uses the esbuild CLI
   via npx so the repo needs no committed node_modules / package-lock. */
import { execSync } from 'node:child_process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

const BANNER = '/*! spin-wheel.js v1.0.0 | MIT | https://github.com/chowtind/spin-wheel */';
/* ESM "export default class" under IIFE yields { default: class } for the
   global — lift the class itself so `new SpinWheel()` works. */
const FOOTER = 'SpinWheel=SpinWheel.default||SpinWheel;';

run(`npx --yes esbuild src/spin-wheel.js --bundle --format=iife --global-name=SpinWheel --target=es2018 --legal-comments=none --banner:js="${BANNER}" --footer:js="${FOOTER}" --outfile=dist/spin-wheel.js`);
run(`npx --yes esbuild src/spin-wheel.js --bundle --format=iife --global-name=SpinWheel --target=es2018 --legal-comments=none --minify --banner:js="${BANNER}" --footer:js="${FOOTER}" --outfile=dist/spin-wheel.min.js`);
run('npx --yes esbuild src/spin-wheel.css --minify --outfile=dist/spin-wheel.min.css');
run('cp src/spin-wheel.css dist/spin-wheel.css');

console.log('built: dist/spin-wheel.js, dist/spin-wheel.min.js, dist/spin-wheel.css, dist/spin-wheel.min.css');

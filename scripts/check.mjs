// Lint-lite: syntax-check every JS file and make sure index.html references files that exist.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

let failed = 0;
for (const dir of ["src", "scripts", "test"]) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!/\.(m?js)$/.test(f)) continue;
    const file = join(dir, f);
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      console.log(`ok    ${file}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${file}\n${e.stderr}`);
    }
  }
}

const html = readFileSync("src/index.html", "utf8");
for (const [, ref] of html.matchAll(/(?:src|href)="([^":#]+\.(?:js|css))"/g)) {
  const ok = existsSync(join("src", ref));
  console.log(`${ok ? "ok   " : "FAIL "} index.html -> ${ref}`);
  if (!ok) failed++;
}

const leaks = /sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}/;
for (const dir of ["src", "assets"]) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (leaks.test(readFileSync(p, "latin1"))) {
      failed++;
      console.error(`FAIL  possible secret in ${p}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} problem(s)`);
  process.exit(1);
}
console.log("\nAll checks passed");

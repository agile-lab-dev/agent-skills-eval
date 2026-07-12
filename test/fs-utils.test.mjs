import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupSkillInstall, installSkillSymlinks } from "../dist/fs-utils.js";

function makeFakeSkillDir() {
  const skillDir = mkdtempSync(path.join(tmpdir(), "fs-utils-skill-"));
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: test\n---\nbody");
  mkdirSync(path.join(skillDir, "references"));
  writeFileSync(path.join(skillDir, "references", "notes.md"), "notes");
  mkdirSync(path.join(skillDir, "evals"));
  writeFileSync(path.join(skillDir, "evals", "evals.json"), '{"evals":[]}');
  return skillDir;
}

test("installSkillSymlinks: symlinks every top-level entry except evals/", () => {
  const skillDir = makeFakeSkillDir();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "fs-utils-install-")), "my-skill");

  installSkillSymlinks(skillDir, installDir);

  assert.ok(lstatSync(path.join(installDir, "SKILL.md")).isSymbolicLink());
  assert.ok(lstatSync(path.join(installDir, "references")).isSymbolicLink());
  assert.equal(existsSync(path.join(installDir, "evals")), false);
});

test("installSkillSymlinks: symlinked entries point at the original files/dirs with the correct type", () => {
  const skillDir = makeFakeSkillDir();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "fs-utils-install-")), "my-skill");

  installSkillSymlinks(skillDir, installDir);

  assert.equal(readlinkSync(path.join(installDir, "SKILL.md")), path.join(skillDir, "SKILL.md"));
  assert.equal(readlinkSync(path.join(installDir, "references")), path.join(skillDir, "references"));
  assert.ok(lstatSync(path.join(installDir, "references")).isSymbolicLink());
  assert.ok(existsSync(path.join(installDir, "references", "notes.md")));
});

test("cleanupSkillInstall: removes the install dir", () => {
  const skillDir = makeFakeSkillDir();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "fs-utils-install-")), "my-skill");
  installSkillSymlinks(skillDir, installDir);
  assert.ok(existsSync(installDir));

  cleanupSkillInstall(installDir);

  assert.equal(existsSync(installDir), false);
});

test("cleanupSkillInstall: is a no-op when the install dir doesn't exist", () => {
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "fs-utils-install-")), "never-installed");
  assert.doesNotThrow(() => cleanupSkillInstall(installDir));
});

test("installSkillSymlinks: does not clear a stale prior install on its own — callers must cleanupSkillInstall first", () => {
  const skillDir = makeFakeSkillDir();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "fs-utils-install-")), "my-skill");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(path.join(installDir, "stale.txt"), "leftover from a previous install");

  installSkillSymlinks(skillDir, installDir);

  assert.ok(existsSync(path.join(installDir, "stale.txt")), "stale entry should still be present");
  assert.ok(lstatSync(path.join(installDir, "SKILL.md")).isSymbolicLink());
});

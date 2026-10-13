import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditError } from "./edit.ts";
import { isInside } from "./paths.ts";

// Opt-in: copy documents into a folder of an Obsidian vault. Kept on the server, so every device agrees.
export type Obsidian = { vault: string; folder: string };

const settingsFile = (root: string) => path.join(root, ".orca", "settings.json");
// Obsidian's own vault list. Only these vaults can be a destination.
const VAULTS = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");

export function listVaults(file = VAULTS): string[] {
  try {
    return Object.values(JSON.parse(fs.readFileSync(file, "utf8")).vaults).map((v: any) => v.path);
  } catch {
    return [];
  }
}

export function readObsidian(root: string): Obsidian | undefined {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(root), "utf8")).obsidian;
  } catch {
    return undefined;
  }
}

// An empty vault turns the copy off.
export function setObsidian(root: string, vault: string, folder: string, vaults = listVaults()): Obsidian | undefined {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile(root), "utf8")); } catch {}
  if (!vault) delete settings.obsidian;
  else {
    if (!vaults.includes(vault)) throw new EditError(`not an Obsidian vault: ${vault}`);
    folderIn(vault, folder);
    settings.obsidian = { vault, folder: folder.trim() };
  }
  fs.mkdirSync(path.dirname(settingsFile(root)), { recursive: true });
  fs.writeFileSync(settingsFile(root), JSON.stringify(settings, null, 2) + "\n");
  return settings.obsidian as Obsidian | undefined;
}

// Copies `file` into the vault folder and returns the copy's path. Never overwrites: a taken name gets -2, -3...
export function copyToObsidian(root: string, file: string): string {
  const o = readObsidian(root);
  if (!o) throw new EditError("no Obsidian vault set; pick one in Settings");
  const dir = folderIn(o.vault, o.folder);
  fs.mkdirSync(dir, { recursive: true });
  const { name, ext } = path.parse(file);
  let dest = path.join(dir, name + ext);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${name}-${i}${ext}`);
  fs.copyFileSync(file, dest);
  return dest;
}

function folderIn(vault: string, folder: string): string {
  const dir = path.resolve(vault, folder.trim());
  if (!isInside(vault, dir)) throw new EditError("the folder must be inside the vault");
  return dir;
}

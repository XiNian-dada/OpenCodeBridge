import { cp, mkdir } from "node:fs/promises";
const target = new URL("../dist/viewer/public/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL("../src/viewer/public/", import.meta.url), target, { recursive: true });

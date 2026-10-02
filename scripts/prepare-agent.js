// Кладёт установщик Device Agent в desktop/agent/, откуда electron-builder
// упакует его внутрь установщика оболочки (extraResources).
// Источник: переменная LITEWMS_AGENT_INSTALLER или последний установщик из соседнего репозитория агента.
const fs = require("node:fs");
const path = require("node:path");

const targetDir = path.join(__dirname, "..", "agent");
const target = path.join(targetDir, "LiteWMS.DeviceAgent-Setup.exe");

function findSource() {
  if (process.env.LITEWMS_AGENT_INSTALLER) return process.env.LITEWMS_AGENT_INSTALLER;
  const dir = path.resolve(__dirname, "..", "..", "..", "..", "LiteWMS.DeviceAgent", "artifacts", "installer");
  if (!fs.existsSync(dir)) return "";
  const files = fs.readdirSync(dir).filter((f) => /^LiteWMS\.DeviceAgent-Setup-.*\.exe$/i.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : "";
}

const source = findSource();
if (!source || !fs.existsSync(source)) {
  console.error("Не найден установщик Device Agent. Задайте LITEWMS_AGENT_INSTALLER=путь\к\LiteWMS.DeviceAgent-Setup-x.y.z.exe");
  process.exit(1);
}
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`Device Agent: ${path.basename(source)} -> agent/`);

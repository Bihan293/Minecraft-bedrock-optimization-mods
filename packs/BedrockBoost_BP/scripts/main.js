// BedrockBoost — оптимизация Minecraft Bedrock для слабых телефонов.
// Скриптовая часть: прогрузка чанков (pregen), подгрузка чанков впереди при полёте
// на элитрах, сканер лагов, очистка предметов, монитор TPS, меню настроек.
//
// Script API: @minecraft/server 2.1.0, @minecraft/server-ui 2.0.0 (Minecraft 1.21.100+)

import {
  system,
  world,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  Player,
  WeatherType,
} from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData, FormCancelationReason } from "@minecraft/server-ui";

const TAG = "§b[BedrockBoost]§r ";
const FLY_AREA_PREFIX = "bb_fly_";
const PREGEN_AREA = "bb_pregen";
const MAX_FLY_AREAS = 3; // в мире максимум 10 ticking area, берём не больше 3

// ───────────────────────────── Настройки ─────────────────────────────

/** @typedef {{hud:number, flyPreload:boolean, flyWarn:boolean, flyRadius:number}} PlayerCfg */
/** @type {PlayerCfg} */
const PLAYER_DEFAULTS = { hud: 1, flyPreload: true, flyWarn: true, flyRadius: 2 };

/** @typedef {{autoClean:boolean, cleanThreshold:number, cleanEvery:number, noWeather:boolean}} WorldCfg */
/** @type {WorldCfg} */
const WORLD_DEFAULTS = { autoClean: false, cleanThreshold: 150, cleanEvery: 5, noWeather: false };

/** @param {Player} p @returns {PlayerCfg} */
function getPlayerCfg(p) {
  try {
    const raw = p.getDynamicProperty("bb:cfg");
    if (typeof raw === "string") return { ...PLAYER_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...PLAYER_DEFAULTS };
}
/** @param {Player} p @param {PlayerCfg} cfg */
function setPlayerCfg(p, cfg) {
  p.setDynamicProperty("bb:cfg", JSON.stringify(cfg));
}
/** @returns {WorldCfg} */
function getWorldCfg() {
  try {
    const raw = world.getDynamicProperty("bb:world");
    if (typeof raw === "string") return { ...WORLD_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...WORLD_DEFAULTS };
}
/** @param {WorldCfg} cfg */
function setWorldCfg(cfg) {
  world.setDynamicProperty("bb:world", JSON.stringify(cfg));
}

// ───────────────────────────── Утилиты ─────────────────────────────

/** @param {import("@minecraft/server").Dimension} dim @param {string} cmd */
function cmd(dim, cmd) {
  try {
    return dim.runCommand(cmd).successCount > 0;
  } catch {
    return false;
  }
}

/** Прогружен ли чанк, в котором лежит точка (x, z). */
function isLoaded(dim, x, z) {
  try {
    return dim.getBlock({ x: Math.floor(x), y: dim.heightRange.min, z: Math.floor(z) }) !== undefined;
  } catch {
    return false;
  }
}

function isOp(p) {
  try {
    return p.playerPermissionLevel >= 2 || p.commandPermissionLevel >= 1;
  } catch {
    return false;
  }
}

function fmt(n) {
  return Math.round(n).toString();
}

// ───────────────────────────── Монитор TPS ─────────────────────────────

let tps = 20;
let lastTpsTime = Date.now();
let lastTpsTick = system.currentTick;
system.runInterval(() => {
  const now = Date.now();
  const dt = (now - lastTpsTime) / 1000;
  const ticks = system.currentTick - lastTpsTick;
  if (dt > 0) tps = Math.min(20, ticks / dt);
  lastTpsTime = now;
  lastTpsTick = system.currentTick;
}, 20);

function tpsColor(v) {
  return v >= 18 ? "§a" : v >= 12 ? "§e" : "§c";
}

// ───────────────────────────── Pregen (прогрузка мира) ─────────────────────────────
// Генерация новых чанков — самая тяжёлая операция в Bedrock. Если сгенерировать
// мир вокруг базы заранее (пока ты AFK / заряжаешь телефон), то во время полёта
// игре нужно только ЗАГРУЗИТЬ готовые чанки с диска, а не генерировать их —
// они появляются заметно быстрее и фризов меньше.

/** @type {null | {dim: import("@minecraft/server").Dimension, points: {x:number,z:number}[], i:number, waitStart:number, ownerId:string, startTime:number}} */
let pregen = null;
let pregenInterval = -1;

function buildSpiral(cx, cz, radiusBlocks) {
  // Квадрат 9x9 чанков (81 чанк ≤ лимита 100), выровненный по сетке чанков.
  // Шаг ровно 144 блока = соседние квадраты стыкуются без дыр.
  const step = 144;
  cx = Math.floor(cx / 16) * 16;
  cz = Math.floor(cz / 16) * 16;
  const n = Math.ceil(radiusBlocks / step);
  /** @type {{x:number,z:number}[]} */
  const pts = [];
  for (let ring = 0; ring <= n; ring++) {
    if (ring === 0) {
      pts.push({ x: cx, z: cz });
      continue;
    }
    for (let i = -ring; i <= ring; i++) {
      pts.push({ x: cx + i * step, z: cz - ring * step });
      pts.push({ x: cx + i * step, z: cz + ring * step });
    }
    for (let i = -ring + 1; i <= ring - 1; i++) {
      pts.push({ x: cx - ring * step, z: cz + i * step });
      pts.push({ x: cx + ring * step, z: cz + i * step });
    }
  }
  return pts.filter((p) => Math.hypot(p.x - cx, p.z - cz) <= radiusBlocks + step / 2);
}

/** @param {Player} player @param {number} radius */
function startPregen(player, radius) {
  if (pregen) {
    player.sendMessage(TAG + "§ePregen уже идёт. Останови его: /bb:pregen 0");
    return;
  }
  radius = Math.max(144, Math.min(4000, Math.floor(radius)));
  const loc = player.location;
  const points = buildSpiral(Math.floor(loc.x), Math.floor(loc.z), radius);
  pregen = { dim: player.dimension, points, i: 0, waitStart: -1, ownerId: player.id, startTime: Date.now() };
  player.sendMessage(
    TAG +
      `§aСтарт прогрузки мира: радиус §f${radius}§a блоков, участков: §f${points.length}§a.\n` +
      "§7Совет: поставь телефон на зарядку и просто стой. Можно играть, но будет чуть медленнее.\n" +
      "§7Остановить: §f/bb:pregen 0"
  );
  pregenInterval = system.runInterval(pregenTick, 5);
}

function stopPregen(reason) {
  if (!pregen) return;
  cmd(pregen.dim, `tickingarea remove ${PREGEN_AREA}`);
  const owner = world.getPlayers().find((p) => p.id === pregen?.ownerId);
  owner?.sendMessage(TAG + reason);
  pregen = null;
  if (pregenInterval !== -1) system.clearRun(pregenInterval);
  pregenInterval = -1;
}

function pregenTick() {
  if (!pregen) return;
  const pg = pregen;
  // Если TPS сильно просел — даём игре передохнуть.
  if (tps < 10) return;
  if (pg.i >= pg.points.length) {
    const min = ((Date.now() - pg.startTime) / 60000).toFixed(1);
    stopPregen(`§aПрогрузка мира завершена за ${min} мин! Теперь полёт на элитрах будет плавнее.`);
    return;
  }
  const p = pg.points[pg.i];
  if (pg.waitStart < 0) {
    cmd(pg.dim, `tickingarea remove ${PREGEN_AREA}`);
    if (!cmd(pg.dim, `tickingarea add ${p.x - 64} 0 ${p.z - 64} ${p.x + 79} 0 ${p.z + 79} ${PREGEN_AREA}`)) {
      // Не удалось (например, лимит 10 зон) — пропускаем точку.
      pg.i++;
      return;
    }
    pg.waitStart = system.currentTick;
    return;
  }
  const done =
    isLoaded(pg.dim, p.x, p.z) &&
    isLoaded(pg.dim, p.x - 64, p.z - 64) &&
    isLoaded(pg.dim, p.x + 79, p.z + 79) &&
    isLoaded(pg.dim, p.x + 79, p.z - 64) &&
    isLoaded(pg.dim, p.x - 64, p.z + 79);
  const timeout = system.currentTick - pg.waitStart > 400;
  if (done || timeout) {
    pg.i++;
    pg.waitStart = -1;
    const owner = world.getPlayers().find((pl) => pl.id === pg.ownerId);
    if (owner) {
      const pct = Math.floor((pg.i / pg.points.length) * 100);
      owner.onScreenDisplay.setActionBar(`§bPregen: §f${pct}%§7 (${pg.i}/${pg.points.length})  TPS ${tpsColor(tps)}${tps.toFixed(1)}`);
    }
  }
}

// ───────────────────────────── Элитры: подгрузка впереди ─────────────────────────────
// Пока ты летишь, мы ставим маленькую ticking area ПЕРЕД тобой по курсу.
// Сервер (на телефоне он внутри игры) начинает генерировать/грузить эти чанки
// на несколько секунд раньше, чем ты туда долетишь.

/** @type {Map<string, {slot:number, lastGlide:number, lastX:number, lastZ:number}>} */
const flyers = new Map();

function freeSlot() {
  const used = new Set([...flyers.values()].map((f) => f.slot));
  for (let i = 0; i < MAX_FLY_AREAS; i++) if (!used.has(i)) return i;
  return -1;
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const p of world.getPlayers()) {
    let cfg;
    try {
      cfg = getPlayerCfg(p);
    } catch {
      continue;
    }
    const v = p.getVelocity();
    const speed = Math.hypot(v.x, v.z) * 20; // блоков в секунду
    const gliding = p.isGliding;
    let hud = "";

    if (gliding && speed > 8) {
      const dirX = v.x / (speed / 20);
      const dirZ = v.z / (speed / 20);
      // Проверяем прогруженность впереди (48 и 96 блоков по курсу)
      const ahead1 = isLoaded(p.dimension, p.location.x + dirX * 48, p.location.z + dirZ * 48);
      const ahead2 = isLoaded(p.dimension, p.location.x + dirX * 96, p.location.z + dirZ * 96);

      if (cfg.flyPreload) {
        let f = flyers.get(p.id);
        if (!f) {
          const slot = freeSlot();
          if (slot >= 0) {
            f = { slot, lastGlide: now, lastX: NaN, lastZ: NaN };
            flyers.set(p.id, f);
          }
        }
        if (f) {
          f.lastGlide = now;
          // Смотрим на ~4 секунды вперёд, но не дальше 200 блоков
          const lookAhead = Math.min(200, Math.max(64, speed * 4));
          const tx = Math.floor(p.location.x + dirX * lookAhead);
          const tz = Math.floor(p.location.z + dirZ * lookAhead);
          // Переставляем зону, только если сместились больше чем на 2 чанка
          if (!(Math.hypot(tx - f.lastX, tz - f.lastZ) < 32)) {
            const name = FLY_AREA_PREFIX + f.slot;
            cmd(p.dimension, `tickingarea remove ${name}`);
            cmd(p.dimension, `tickingarea add circle ${tx} 64 ${tz} ${cfg.flyRadius} ${name}`);
            f.lastX = tx;
            f.lastZ = tz;
          }
        }
      }

      if (cfg.flyWarn) {
        if (!ahead1) hud = "§c§l⚠ ВПЕРЕДИ НЕ ПРОГРУЖЕНО §r§c— сбавь скорость!";
        else if (!ahead2) hud = `§e⚠ Чанки догружаются... §f${fmt(speed)} б/с`;
        else hud = `§a✈ §f${fmt(speed)} б/с §7| §aпуть прогружен`;
      }
    } else {
      const f = flyers.get(p.id);
      if (f && now - f.lastGlide > 200) {
        cmd(p.dimension, `tickingarea remove ${FLY_AREA_PREFIX}${f.slot}`);
        flyers.delete(p.id);
      }
    }

    if (!hud && cfg.hud === 1 && !pregen) {
      hud = `§7TPS ${tpsColor(tps)}${tps.toFixed(1)}`;
    } else if (!hud && cfg.hud === 2 && !pregen) {
      const ents = safeCount(p);
      hud = `§7TPS ${tpsColor(tps)}${tps.toFixed(1)} §7| сущностей рядом: ${ents > 150 ? "§c" : ents > 80 ? "§e" : "§a"}${ents}`;
    }
    if (hud) p.onScreenDisplay.setActionBar(hud);
  }
}, 20);

function safeCount(p) {
  try {
    return p.dimension.getEntities({ location: p.location, maxDistance: 48 }).length;
  } catch {
    return 0;
  }
}

world.afterEvents.playerLeave.subscribe((e) => {
  const f = flyers.get(e.playerId);
  if (f) {
    cmd(world.getDimension("overworld"), `tickingarea remove ${FLY_AREA_PREFIX}${f.slot}`);
    flyers.delete(e.playerId);
  }
});

// ───────────────────────────── Сканер лагов ─────────────────────────────

const NAMES = {
  "minecraft:item": "Предметы на земле",
  "minecraft:xp_orb": "Опыт (шарики)",
  "minecraft:chicken": "Куры",
  "minecraft:cow": "Коровы",
  "minecraft:sheep": "Овцы",
  "minecraft:pig": "Свиньи",
  "minecraft:villager_v2": "Жители",
  "minecraft:zombie": "Зомби",
  "minecraft:skeleton": "Скелеты",
  "minecraft:iron_golem": "Големы",
  "minecraft:armor_stand": "Стойки для брони",
  "minecraft:item_frame": "Рамки",
  "minecraft:glow_frame": "Светящиеся рамки",
  "minecraft:arrow": "Стрелы",
  "minecraft:minecart": "Вагонетки",
  "minecraft:hopper_minecart": "Вагонетки-воронки",
  "minecraft:bee": "Пчёлы",
  "minecraft:fox": "Лисы",
  "minecraft:wolf": "Волки",
  "minecraft:cat": "Кошки",
};

/** @param {Player} p */
function scanLag(p) {
  /** @type {import("@minecraft/server").Entity[]} */
  let ents = [];
  try {
    ents = p.dimension.getEntities({ location: p.location, maxDistance: 96 });
  } catch {}
  /** @type {Record<string, number>} */
  const byType = {};
  /** @type {Record<string, number>} */
  const byChunk = {};
  for (const e of ents) {
    if (e.typeId === "minecraft:player") continue;
    byType[e.typeId] = (byType[e.typeId] ?? 0) + 1;
    const key = `${Math.floor(e.location.x / 16)},${Math.floor(e.location.z / 16)}`;
    byChunk[key] = (byChunk[key] ?? 0) + 1;
  }
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  const top = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const hot = Object.entries(byChunk).sort((a, b) => b[1] - a[1]).slice(0, 3);

  let body = `§fСущностей в радиусе 96 блоков: ${total > 300 ? "§c" : total > 150 ? "§e" : "§a"}${total}\n`;
  body += `§fTPS сейчас: ${tpsColor(tps)}${tps.toFixed(1)}§f / 20\n\n§lТоп по типам:§r\n`;
  for (const [t, n] of top) body += ` §7• §f${NAMES[t] ?? t.replace("minecraft:", "")}: ${n > 50 ? "§c" : n > 20 ? "§e" : "§a"}${n}\n`;
  body += "\n§lСамые нагруженные чанки:§r\n";
  for (const [k, n] of hot) {
    const [cx, cz] = k.split(",").map(Number);
    body += ` §7• §fX ${cx * 16 + 8}, Z ${cz * 16 + 8}: ${n > 40 ? "§c" : "§e"}${n} сущн.\n`;
  }
  body += "\n§lСоветы:§r\n";
  const items = (byType["minecraft:item"] ?? 0) + (byType["minecraft:xp_orb"] ?? 0);
  if (items > 50) body += " §e• Много лута на земле — нажми «Очистить предметы».\n";
  const animals = ["minecraft:chicken", "minecraft:cow", "minecraft:sheep", "minecraft:pig"].reduce((a, t) => a + (byType[t] ?? 0), 0);
  if (animals > 40) body += " §e• Ферма животных слишком большая — оставь по 10-15 штук.\n";
  if ((byType["minecraft:villager_v2"] ?? 0) > 20) body += " §e• Много жителей — они очень тяжёлые для ИИ.\n";
  if ((byType["minecraft:item_frame"] ?? 0) + (byType["minecraft:glow_frame"] ?? 0) + (byType["minecraft:armor_stand"] ?? 0) > 40)
    body += " §e• Рамки и стойки рисуются как мобы — их много, убери часть.\n";
  if (hot[0] && hot[0][1] > 40) body += " §e• Есть чанк с толпой сущностей — проверь координаты выше.\n";
  body += " §7• Воронки, редстоун-часы и печи тоже грузят базу, сканер их не видит.\n";
  if (total < 80) body += " §a• С сущностями всё хорошо. Лаги, скорее всего, от графики — смотри «Советы по настройкам».\n";

  new ActionFormData().title("§lСканер лагов").body(body).button("§aОчистить предметы").button("Назад").show(p).then((r) => {
    if (r.selection === 0) cleanItems(p, true);
    else if (r.selection === 1) openMenu(p);
  });
}

// ───────────────────────────── Очистка ─────────────────────────────

/** Удаляет предметы и опыт на земле, кроме тех, что прямо рядом с игроками. */
function cleanItems(source, onlyNear) {
  let removed = 0;
  const players = world.getPlayers();
  for (const dimId of ["overworld", "nether", "the_end"]) {
    const dim = world.getDimension(dimId);
    /** @type {import("@minecraft/server").Entity[]} */
    let ents = [];
    try {
      if (onlyNear && source) {
        if (source.dimension.id !== dim.id) continue;
        ents = dim.getEntities({ location: source.location, maxDistance: 128, type: "minecraft:item" });
        ents = ents.concat(dim.getEntities({ location: source.location, maxDistance: 128, type: "minecraft:xp_orb" }));
      } else {
        ents = dim.getEntities({ type: "minecraft:item" }).concat(dim.getEntities({ type: "minecraft:xp_orb" }));
      }
    } catch {
      continue;
    }
    for (const e of ents) {
      try {
        const near = players.some(
          (pl) => pl.dimension.id === dim.id && Math.hypot(pl.location.x - e.location.x, pl.location.y - e.location.y, pl.location.z - e.location.z) < 5
        );
        if (near) continue;
        e.remove();
        removed++;
      } catch {}
    }
  }
  if (source) source.sendMessage(TAG + `§aУдалено предметов/опыта: §f${removed}`);
  else if (removed > 0) world.sendMessage(TAG + `§7Автоочистка: удалено §f${removed}§7 предметов с земли.`);
  return removed;
}

let cleanTimer = 0;
system.runInterval(() => {
  const cfg = getWorldCfg();
  if (!cfg.autoClean) {
    cleanTimer = 0;
    return;
  }
  cleanTimer++;
  if (cleanTimer < cfg.cleanEvery * 60) return;
  let count = 0;
  for (const dimId of ["overworld", "nether", "the_end"]) {
    try {
      count += world.getDimension(dimId).getEntities({ type: "minecraft:item" }).length;
    } catch {}
  }
  if (count < cfg.cleanThreshold) {
    cleanTimer = cfg.cleanEvery * 60 - 30; // проверим ещё раз через 30 сек
    return;
  }
  cleanTimer = 0;
  world.sendMessage(TAG + `§eНа земле ${count} предметов. Очистка через 15 секунд! Подбери нужное.`);
  system.runTimeout(() => cleanItems(undefined, false), 300);
}, 20);

// ───────────────────────────── Погода ─────────────────────────────

function applyWeather() {
  const cfg = getWorldCfg();
  try {
    if (cfg.noWeather) {
      world.gameRules.doWeatherCycle = false;
      world.getDimension("overworld").setWeather(WeatherType.Clear);
    } else {
      world.gameRules.doWeatherCycle = true;
    }
  } catch {}
}

// ───────────────────────────── Меню ─────────────────────────────

/** @param {Player} p */
function openMenu(p) {
  const form = new ActionFormData()
    .title("§l§bBedrockBoost")
    .body(`§7TPS: ${tpsColor(tps)}${tps.toFixed(1)}§7/20   Pregen: ${pregen ? `§a${Math.floor((pregen.i / pregen.points.length) * 100)}%` : "§7выкл."}\n§7Выбери действие:`)
    .button("§2Прогрузить мир вокруг\n§8(pregen для элитр)") // 0
    .button("§6Сканер лагов\n§8что тормозит базу") // 1
    .button("§cОчистить предметы\n§8в радиусе 128 блоков") // 2
    .button("§9Мои настройки\n§8HUD, элитры") // 3
    .button("§5Настройки мира\n§8автоочистка, погода") // 4
    .button("§eСоветы по настройкам\n§8как поднять FPS"); // 5
  showForm(p, form, (r) => {
    switch (r.selection) {
      case 0:
        return pregenMenu(p);
      case 1:
        return scanLag(p);
      case 2:
        return cleanItems(p, true);
      case 3:
        return playerSettings(p);
      case 4:
        return worldSettings(p);
      case 5:
        return tips(p);
    }
  });
}

/** Показывает форму, повторяя попытку, если игрок ещё в чате (UserBusy). */
function showForm(p, form, cb, tries = 0) {
  form.show(p).then((r) => {
    if (r.canceled && r.cancelationReason === FormCancelationReason.UserBusy && tries < 40) {
      system.runTimeout(() => showForm(p, form, cb, tries + 1), 10);
      return;
    }
    if (!r.canceled) cb(r);
  });
}

/** @param {Player} p */
function pregenMenu(p) {
  if (pregen) {
    new MessageFormData()
      .title("Pregen")
      .body(`Идёт прогрузка: ${pregen.i}/${pregen.points.length}.\nОстановить?`)
      .button1("Остановить")
      .button2("Продолжить")
      .show(p)
      .then((r) => {
        if (r.selection === 0) stopPregen("§eПрогрузка остановлена.");
      });
    return;
  }
  const radii = [500, 1000, 1500, 2000, 3000];
  const time = ["3-5 мин", "10-20 мин", "25-45 мин", "40-80 мин", "1.5-3 часа"];
  const form = new ActionFormData()
    .title("Прогрузка мира")
    .body(
      "§7Игра заранее сгенерирует мир вокруг тебя. Потом при полёте чанки будут " +
        "появляться быстрее и без фризов генерации.\n\n" +
        "§7Время зависит от телефона. Сохранение вырастет примерно на 5-20 МБ на каждые 1000 блоков.\n" +
        "§eСтой на месте и поставь телефон на зарядку."
    );
  radii.forEach((r, i) => form.button(`§2${r} блоков\n§8≈ ${time[i]}`));
  form.button("Назад");
  showForm(p, form, (r) => {
    const idx = r.selection ?? radii.length;
    if (idx >= radii.length) return openMenu(p);
    startPregen(p, radii[idx]);
  });
}

/** @param {Player} p */
function playerSettings(p) {
  const cfg = getPlayerCfg(p);
  showForm(
    p,
    new ModalFormData()
      .title("Мои настройки")
      .dropdown("HUD (строка над хотбаром)", ["Выкл.", "TPS", "TPS + сущности рядом"], { defaultValueIndex: cfg.hud })
      .toggle("Подгружать чанки впереди при полёте на элитрах", { defaultValue: cfg.flyPreload })
      .toggle("Предупреждать, если впереди не прогружено", { defaultValue: cfg.flyWarn })
      .slider("Размер зоны подгрузки (чанки). Больше = дальше видно, но тяжелее", 1, 4, { defaultValue: cfg.flyRadius, valueStep: 1 }),
    (r) => {
      const v = r.formValues ?? [];
      setPlayerCfg(p, {
        hud: Number(v[0] ?? cfg.hud),
        flyPreload: Boolean(v[1]),
        flyWarn: Boolean(v[2]),
        flyRadius: Number(v[3] ?? cfg.flyRadius),
      });
      p.sendMessage(TAG + "§aНастройки сохранены.");
    }
  );
}

/** @param {Player} p */
function worldSettings(p) {
  if (!isOp(p)) {
    p.sendMessage(TAG + "§cНастройки мира доступны только оператору.");
    return;
  }
  const cfg = getWorldCfg();
  showForm(
    p,
    new ModalFormData()
      .title("Настройки мира")
      .toggle("Автоочистка предметов на земле", { defaultValue: cfg.autoClean })
      .slider("Чистить, если предметов больше чем", 50, 500, { defaultValue: cfg.cleanThreshold, valueStep: 25 })
      .slider("Проверять каждые (минут)", 1, 30, { defaultValue: cfg.cleanEvery, valueStep: 1 })
      .toggle("Отключить дождь и грозу (дождь сильно режет FPS на телефоне)", { defaultValue: cfg.noWeather }),
    (r) => {
      const v = r.formValues ?? [];
      setWorldCfg({
        autoClean: Boolean(v[0]),
        cleanThreshold: Number(v[1] ?? cfg.cleanThreshold),
        cleanEvery: Number(v[2] ?? cfg.cleanEvery),
        noWeather: Boolean(v[3]),
      });
      applyWeather();
      p.sendMessage(TAG + "§aНастройки мира сохранены.");
    }
  );
}

/** @param {Player} p */
function tips(p) {
  const body = [
    "§l§eНастройки → Видео (самое важное):§r",
    "§f• Дальность прорисовки: §a6-8 §7(не больше 10 на слабом телефоне)",
    "§f• Моделирование (Simulation distance): §a4 §7— очень сильно разгружает CPU",
    "§f• Красивое небо: §cВЫКЛ",
    "§f• Красивая листва: §cВЫКЛ",
    "§f• Красивые пузыри: §cВЫКЛ",
    "§f• Облака: §cВЫКЛ",
    "§f• Мягкое освещение: §cВЫКЛ",
    "§f• Прозрачная листва: §cВЫКЛ",
    "§f• Тени сущностей / Отображение частиц у ног: §cВЫКЛ",
    "§f• Масштаб интерфейса/разрешение рендера (Render Resolution / Graphics): §aуменьшить до 70-80%",
    "§f• V-Sync: §cВЫКЛ§7, Ограничение FPS: §a30 §7(стабильнее, меньше греется)",
    "§f• Генерация чанков на клиенте (Client-side chunk generation): §aВКЛ",
    "§f• Vibrant Visuals / RTX: §cВЫКЛ",
    "",
    "§l§eПро чанки и элитры:§r",
    "§f• Сначала сделай §aPregen§f на 1000-2000 блоков вокруг базы.",
    "§f• Летай на высоте 150-200: меньше блоков = чанки строятся быстрее.",
    "§f• Не жми фейерверки подряд — лети на скорости 30-40 б/с, тогда чанки успевают.",
    "",
    "§l§eПро базу:§r",
    "§f• Используй §6Сканер лагов§f — найдёт толпы мобов и лута.",
    "§f• Меньше рамок, стоек, табличек, баннеров — они рисуются дорого.",
    "§f• Выключай редстоун-часы и ненужные воронки.",
    "",
    "§l§eПро телефон:§r",
    "§f• Закрой все приложения в фоне, включи режим производительности/игровой режим.",
    "§f• Не играй на зарядке, если телефон сильно греется — он начинает тормозить от перегрева.",
    "§f• В ресурс-паке BedrockBoost можно выбрать уровень: Сбалансированный / Макс. FPS / Картошка",
    "§7  (Настройки мира → Наборы ресурсов → BedrockBoost → шестерёнка).",
  ].join("\n");
  new ActionFormData().title("Советы по FPS").body(body).button("Назад").show(p).then((r) => {
    if (r.selection === 0) openMenu(p);
  });
}

// ───────────────────────────── Команды и открытие меню ─────────────────────────────

system.beforeEvents.startup.subscribe((ev) => {
  const reg = ev.customCommandRegistry;
  /** @param {string} name @param {string} description @param {(p: Player, ...args:any[]) => void} fn @param {import("@minecraft/server").CustomCommandParameter[]} [opt] */
  const add = (name, description, fn, opt) =>
    reg.registerCommand(
      { name, description, permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false, optionalParameters: opt },
      (origin, ...args) => {
        const src = origin.sourceEntity;
        if (!(src instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Только для игроков" };
        system.run(() => fn(src, ...args));
        return { status: CustomCommandStatus.Success };
      }
    );
  add("bb:menu", "Открыть меню BedrockBoost", (p) => openMenu(p));
  add("bb:scan", "Сканер лагов BedrockBoost", (p) => scanLag(p));
  add("bb:clean", "Очистить предметы на земле рядом", (p) => cleanItems(p, true));
  add(
    "bb:pregen",
    "Прогрузить мир вокруг (радиус в блоках, 0 = стоп)",
    (p, radius) => {
      if (radius === 0) return pregen ? stopPregen("§eПрогрузка остановлена.") : p.sendMessage(TAG + "Pregen не запущен.");
      startPregen(p, typeof radius === "number" ? radius : 1000);
    },
    [{ name: "radius", type: CustomCommandParamType.Integer }]
  );
});

// Запасные способы открыть меню: /scriptevent bb:menu  или  присесть + использовать палку.
system.afterEvents.scriptEventReceive.subscribe((e) => {
  if (e.id === "bb:menu" && e.sourceEntity instanceof Player) openMenu(e.sourceEntity);
});
world.afterEvents.itemUse.subscribe((e) => {
  if (e.itemStack.typeId === "minecraft:stick" && e.source.isSneaking) openMenu(e.source);
});

world.afterEvents.playerSpawn.subscribe((e) => {
  if (!e.initialSpawn) return;
  const p = e.player;
  if (p.getDynamicProperty("bb:welcomed")) return;
  p.setDynamicProperty("bb:welcomed", true);
  system.runTimeout(() => {
    p.sendMessage(
      TAG +
        "§aУстановлен! Меню: §f/bb:menu§a или присядь и нажми ПКМ палкой.\n" +
        "§7Начни с «Советы по настройкам», потом сделай «Прогрузить мир вокруг»."
    );
  }, 100);
});

world.afterEvents.worldLoad.subscribe(() => {
  // Убираем «осиротевшие» зоны после вылета/перезахода
  for (const id of ["overworld", "nether", "the_end"]) {
    const d = world.getDimension(id);
    for (let i = 0; i < MAX_FLY_AREAS; i++) cmd(d, `tickingarea remove ${FLY_AREA_PREFIX}${i}`);
    cmd(d, `tickingarea remove ${PREGEN_AREA}`);
  }
  applyWeather();
});

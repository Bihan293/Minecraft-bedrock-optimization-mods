#!/usr/bin/env python3
"""
BedrockBoost — генератор оптимизированных партиклов.

Берёт ванильные определения партиклов из официального репозитория Mojang
(https://github.com/Mojang/bedrock-samples) и создаёт три уровня оптимизации
(сабпаки ресурс-пака):

  balanced – -40% частиц, без физики столкновений у декоративных партиклов
  maxfps   – -70% частиц, без столкновений у всех, короче жизнь частиц,
             декоративные (листья, светлячки, споры, пыль, капли) выключены
  potato   – почти всё выключено, остаются только важные для геймплея
             (крит, тотем, взрывы, порталы) в минимальном количестве

Почему это даёт FPS: на телефоне каждая частица — это отдельный billboard,
а `particle_motion_collision` заставляет CPU каждый кадр проверять столкновение
каждой частицы с блоками. Листопад в лесу (biome_tinted_leaves) по умолчанию
допускает до 2000 частиц на эмиттер!

Использование:
  python3 tools/build_particles.py <путь к bedrock-samples/resource_pack/particles>
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RP = ROOT / "packs" / "BedrockBoost_RP" / "subpacks"

# Чисто декоративные партиклы: можно смело убирать коллизию, а на maxfps — выключать.
AMBIENT = {
    "biome_tinted_leaves_particle", "cherry_leaves_particle", "pale_oak_leaves_particle",
    "orange_poplar_leaves_particle", "red_poplar_leaves_particle", "yellow_poplar_leaves_particle",
    "spore_blossom_ambient_block_actor", "spore_blossom_shower", "firefly_particle",
    "mycelium_dust", "falling_border_dust", "rising_border_dust", "obsidian_glow_dust",
    "obsidian_tear", "infested_ambient", "oozing_ambient", "weaving_ambient",
    "wind_charged_ambient", "raid_omen_ambient", "trial_omen_ambient", "mobspell_ambient",
    "dripstone_lava_drip", "dripstone_water_drip", "water_drip", "lava_drip", "honey_drip",
    "nectar_drip", "underwater_torch_bubble", "redstone_wire_dust", "redstone_torch_dust",
    "redstone_repeater_dust", "redstone_ore_dust", "enchanting_table_particle",
    "end_chest", "conduit", "sculk_soul", "eyeblossom_open", "eyeblossom_close",
    "creaking_heart_trail", "lab_table_heatblock_dust", "lab_table_misc_mystical",
    "sulfur_bubble_particle", "sulfur_cube_particle", "noxious_gas_particle",
    "candle_flame", "small_soul_fire_flame", "glow", "lava_particle",
}
# Важные для геймплея — никогда не выключаем полностью (даже на potato).
CRITICAL = {
    "critical_hit", "magic_critical_hit", "totem", "totem_manual", "basic_portal",
    "portal_directional", "portal_east_west", "portal_north_south", "portal_reverse",
    "explosion_level", "large_explosion_level", "huge_explosion_level", "basic_flame",
    "mobflame", "mobflame_single", "heart", "villager_happy", "villager_angry",
    "trial_spawner_detection.particle", "trial_spawner_detection_ominous.particle",
    "vibration_signal", "shriek", "sonic_explosion", "guardian_attack", "fish_hook",
    "fish_pos", "block_destruct", "breaking_item_icon", "breaking_item_terrain",
    "water_splash", "wind_explosion", "breeze_wind_explosion", "note",
}
# Тяжёлые эмиттеры с огромными лимитами — режем сильнее даже на balanced.
HEAVY = {
    "biome_tinted_leaves_particle", "cherry_leaves_particle", "pale_oak_leaves_particle",
    "campfire_smoke", "campfire_smoke_tall", "rain_splash", "spore_blossom_shower",
    "bubble_column_up", "bubble_column_down", "bubble_column_bubble", "basic_smoke",
}

TIERS = {
    #            count  heavy  lifetime  collision_off   disable
    "balanced": (0.60,  0.25,  1.00,     "ambient",      set()),
    "maxfps":   (0.30,  0.10,  0.70,     "all",          AMBIENT),
    "potato":   (0.15,  0.05,  0.50,     "all",          "all_but_critical"),
}


def load(path: Path):
    text = path.read_text(encoding="utf-8-sig")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        text = re.sub(r"(?m)^\s*//.*$", "", text)
        text = re.sub(r",(\s*[}\]])", r"\1", text)
        return json.loads(text)


def scale(value, k, minimum=1):
    """Масштабирует число или Molang-выражение."""
    if isinstance(value, (int, float)):
        if value <= 0:
            return value
        return max(minimum, int(round(value * k)))
    if isinstance(value, str):
        return f"math.max({minimum}, math.floor(({value}) * {k}))"
    return value


def scale_time(value, k):
    if k >= 1:
        return value
    if isinstance(value, (int, float)):
        return round(value * k, 3)
    if isinstance(value, str):
        return f"({value}) * {k}"
    return value


def disable(comps):
    """Делает эмиттер «пустым», не ломая идентификатор (игра не ругается)."""
    if "minecraft:emitter_rate_instant" in comps:
        comps["minecraft:emitter_rate_instant"]["num_particles"] = 0
    if "minecraft:emitter_rate_manual" in comps:
        comps["minecraft:emitter_rate_manual"]["max_particles"] = 0
    if "minecraft:emitter_rate_steady" in comps:
        comps["minecraft:emitter_rate_steady"]["spawn_rate"] = 0
        comps["minecraft:emitter_rate_steady"]["max_particles"] = 0
    comps.pop("minecraft:particle_motion_collision", None)
    comps["minecraft:particle_lifetime_expression"] = {"max_lifetime": 0.05}


def optimize(name, data, tier):
    count_k, heavy_k, life_k, coll_mode, disabled = TIERS[tier]
    comps = data["particle_effect"]["components"]

    is_disabled = (disabled == "all_but_critical" and name not in CRITICAL) or \
                  (isinstance(disabled, set) and name in disabled)
    if is_disabled:
        disable(comps)
        return data, "off"

    k = heavy_k if name in HEAVY else count_k
    minimum = 1 if name in CRITICAL else 0
    if name in CRITICAL:
        k = max(k, 0.35)

    r = comps.get("minecraft:emitter_rate_instant")
    if r and "num_particles" in r:
        r["num_particles"] = scale(r["num_particles"], k, max(1, minimum))
    r = comps.get("minecraft:emitter_rate_manual")
    if r and "max_particles" in r:
        r["max_particles"] = scale(r["max_particles"], k, 1)
    r = comps.get("minecraft:emitter_rate_steady")
    if r:
        if "spawn_rate" in r:
            r["spawn_rate"] = scale(r["spawn_rate"], k, 1)
        if "max_particles" in r:
            r["max_particles"] = scale(r["max_particles"], k, 1)

    life = comps.get("minecraft:particle_lifetime_expression")
    if life and "max_lifetime" in life and name not in CRITICAL:
        life["max_lifetime"] = scale_time(life["max_lifetime"], life_k)

    # Коллизия частиц — самая дорогая часть для CPU телефона.
    # Партиклы с событиями на столкновение (expire_on_contact / events) не трогаем
    # на balanced, чтобы капли и т.п. вели себя правильно.
    coll = comps.get("minecraft:particle_motion_collision")
    if coll is not None:
        has_logic = bool(coll.get("events")) or coll.get("expire_on_contact")
        if coll_mode == "all" and not (has_logic and name in CRITICAL):
            comps.pop("minecraft:particle_motion_collision")
        elif coll_mode == "ambient" and name in AMBIENT and not has_logic:
            comps.pop("minecraft:particle_motion_collision")
    return data, f"x{k}"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = Path(sys.argv[1])
    files = sorted(src.glob("*.json"))
    if not files:
        sys.exit(f"Нет партиклов в {src}")
    stats = {}
    for tier in TIERS:
        out = RP / tier / "particles"
        out.mkdir(parents=True, exist_ok=True)
        for old in out.glob("*.json"):
            old.unlink()
        off = 0
        for f in files:
            name = f.name[:-5]
            data, res = optimize(name, load(f), tier)
            off += res == "off"
            (out / f.name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        stats[tier] = (len(files), off)
    for tier, (n, off) in stats.items():
        print(f"{tier:9s}: {n} партиклов оптимизировано, {off} выключено")


if __name__ == "__main__":
    main()

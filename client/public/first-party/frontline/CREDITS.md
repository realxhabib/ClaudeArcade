# Frontline — asset credits

Every downloaded asset here is **CC0 1.0 (public domain)**. No attribution is
required; we credit the authors anyway. Nothing here is derived from any
commercial game: the container brands (Halcyon, Tasman Line, Orbis, Korvax,
Meridian, Nordwave, Anchora) and their logos are invented and drawn in code
(`src/first-party/frontline/textures.ts`).

What each tier downloads: **low** ≈ 0.17 MB (`lo/`), **medium** ≈ 4.6 MB
(`mid/`, `sky_1k.hdr`, `soldier.glb`), **high** ≈ 8.3 MB (the containers and the
asphalt from `hi/` at 2K, the rest shared with medium).

## Textures — Poly Haven (https://polyhaven.com, CC0)

Converted to WebP (albedo, OpenGL normal, AO/roughness/metal packed "ARM");
`hi/` 2K, `mid/` 1K, `lo/` 512 px albedo only (the low tier has no normal maps, so its
container and cladding albedos have the corrugation shading baked in from the
normal maps). The container albedo was
neutralized to gray so each container can be tinted; the painted-metal albedo
carries a paint/rust mask in its alpha; `container_grime.webp` (rust streaks and
dirt) was derived from Rusty Metal 02.

| File prefix | Source | Author(s) | URL |
| --- | --- | --- | --- |
| `container_*` | Container Side | Dimitrios Savva | https://polyhaven.com/a/container_side |
| `asphalt_*` | Asphalt 02 | Rob Tuytel | https://polyhaven.com/a/asphalt_02 |
| `concrete_*` | Concrete Wall 008 | Charlotte Baglioni (photo), Dario Barresi (processing) | https://polyhaven.com/a/concrete_wall_008 |
| `planks_*` | Weathered Planks | Dimitrios Savva (photo), Dario Barresi (processing) | https://polyhaven.com/a/weathered_planks |
| `painted_*`, `container_grime` | Rusty Metal 02 | Rob Tuytel | https://polyhaven.com/a/rusty_metal_02 |
| `plate_*` | Metal Plate | Rob Tuytel | https://polyhaven.com/a/metal_plate |
| `cladding_*` | Corrugated Iron 02 | Sergej Majboroda (photo), Jenelle van Heerden (processing) | https://polyhaven.com/a/corrugated_iron_02 |
| `fabric_normal` | Rough Linen | colormass (photo), Rico Cilliers (processing) | https://polyhaven.com/a/rough_linen |

## Sky — Poly Haven (CC0)

| File | Source | Author(s) | URL |
| --- | --- | --- | --- |
| `sky_1k.hdr` | Qwantani Late Afternoon (Pure Sky), 1K HDR | Greg Zaal (photo), Jarod Guest (processing) | https://polyhaven.com/a/qwantani_late_afternoon_puresky |

## Soldier — Quaternius (https://quaternius.com, CC0)

`soldier.glb` combines, re-exported with glTF-Transform (mesh simplified to
~5.3k triangles, meshopt-compressed):

| Part | Source | Author | URL |
| --- | --- | --- | --- |
| Body mesh and skeleton (Superhero_Male_FullBody) | Universal Base Characters [Standard] | Quaternius | https://quaternius.itch.io/universal-base-characters |
| Clips: idle, walk, jog, sprint, crouch idle/walk, jump, pistol idle/aim/shoot/reload, death, hit | Universal Animation Library [Standard] | Quaternius | https://quaternius.itch.io/universal-animation-library |
| Clip: overhand throw | Universal Animation Library 2 [Standard] | Quaternius | https://quaternius.itch.io/universal-animation-library-2 |

The uniform, camo, plate carrier, pouches, helmet, goggles and the guns are
generated in code (`soldier.ts`, `viewmodel.ts`).

## Made in code (no downloads)

Container logos and ID stencils, lane paint, oil stains, puddle/wetness masks,
chain-link, smoke / fire / scorch / muzzle-flash sprites, all sounds (WebAudio
synthesis), the weapons, the grenade.

License text: https://creativecommons.org/publicdomain/zero/1.0/

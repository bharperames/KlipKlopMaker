# Print suitability — geometry v2.0.0

| part | ok | cm³ | g | W×D×H mm | 1st layer mm² | contact | slender | ≤25° | 25–45° | unsupported | low island |
|---|---|---|---|---|---|---|---|---|---|---|---|
| start (viaduct) | ✔ | 56.4 | 69.9 | 150×53×40 | 1548 | 20% | 0.8 | 6221 | 2 | 6214 | 0 |
| straight (viaduct) | ✔ | 60.2 | 74.6 | 150×53×56 | 1030 | 13% | 1.1 | 6477 | 251 | 6717 | 0 |
| curveL (viaduct) | ✔ | 86.2 | 107 | 170×170×71 | 1031 | 4% | 0.4 | 10452 | 267 | 10694 | 0 |
| lift (viaduct) | ✔ | 59.8 | 74.2 | 150×53×56 | 1030 | 13% | 1.1 | 6486 | 244 | 6721 | 0 |
| powered (viaduct) | ✔ | 42.4 | 52.6 | 150×53×26 | 1206 | 15% | 0.5 | 6458 | 7 | 6457 | 0 |
| elevator (viaduct) | ✔ | 354 | 440 | 150×53×116 | 3753 | 47% | 2.2 | 2701 | 82 | 2772 | 0 |
| end (viaduct) | ✔ | 41.6 | 51.6 | 150×53×26 | 1164 | 15% | 0.5 | 6605 | 2 | 6599 | 0 |
| start (minimal) | ✔ | 56.4 | 69.9 | 150×53×40 | 1548 | 20% | 0.8 | 6221 | 2 | 6214 | 0 |
| straight (minimal) | ✔ | 52.8 | 65.5 | 159×53×29 | 1480 | 18% | 0.5 | 6427 | 7 | 6424 | 196 |
| curveL (minimal) | ✔ | 82.9 | 103 | 179×178×39 | 1777 | 6% | 0.2 | 10144 | 6 | 9961 | 0 |
| lift (minimal) | ✔ | 52.9 | 65.5 | 159×53×29 | 1481 | 18% | 0.5 | 6432 | 8 | 6405 | 196 |
| powered (minimal) | ✔ | 45.6 | 56.5 | 150×53×26 | 1548 | 20% | 0.5 | 6220 | 2 | 6214 | 0 |
| elevator (minimal) | ✔ | 327 | 405 | 150×53×116 | 3530 | 45% | 2.2 | 2480 | 699 | 3167 | 0 |
| end (minimal) | ✔ | 41.6 | 51.6 | 150×53×26 | 1164 | 15% | 0.5 | 6605 | 2 | 6599 | 0 |
| switchL (viaduct) | ✔ | 121 | 150 | 170×174×71 | 1412 | 5% | 0.4 | 13001 | 586 | 13572 | 1 |
| switchL (minimal) | ✔ | 122 | 152 | 182×178×42 | 2680 | 8% | 0.2 | 12597 | 29 | 11994 | 23 |
| bowtie_key | ✔ | 4.09 | 5.07 | 23×18×12 | 315 | 78% | 0.6 | 0 | 0 | 0 | 0 |
| gate_paddle | ✔ | 1.83 | 2.27 | 6×53×20 | 148 | 48% | 3.4 | 0 | 0 | 0 | 0 |
| spacer SPS (16.59) | ✔ | 3.64 | 4.52 | 16×18×26 | 154 | 56% | 1.6 | 191 | 0 | 70 | 0 |
| spacer SPC (11.2) | ✔ | 2.42 | 3.00 | 16×18×20 | 154 | 56% | 1.3 | 131 | 0 | 70 | 0 |
| support_foot | ✔ | 7.18 | 8.90 | 42×36×24 | 1049 | 70% | 0.7 | 0 | 0 | 0 | 0 |
| riser 120 | ✔ | 23.2 | 28.8 | 17×15×129 | 118 | 45% | 8.6 | 70 | 0 | 70 | 0 |
| riser 60 | ✔ | 11.6 | 14.3 | 17×15×69 | 118 | 45% | 4.6 | 70 | 0 | 70 | 0 |
| riser 30 | ✔ | 5.71 | 7.08 | 17×15×39 | 118 | 45% | 2.6 | 70 | 0 | 70 | 0 |
| riser 15 | ✔ | 2.79 | 3.46 | 17×15×24 | 118 | 45% | 1.6 | 70 | 0 | 70 | 0 |
| support_jog | ✔ | 11.3 | 14.0 | 62×15×24 | 686 | 73% | 1.6 | 70 | 0 | 70 | 0 |
| scenery_tower | ✔ | 114 | 141 | 51×44×115 | 1509 | 68% | 2.6 | 746 | 0 | 70 | 0 |
| scenery_patio | ✔ | 193 | 239 | 150×150×22 | 22500 | 100% | 0.1 | 0 | 0 | 0 | 0 |

# The height ladder

Grid 15 mm · foot 15 · risers 120, 60, 30, 15 · jog 15 · spacers SPS 16.59, SPC 11.2

| design | style | supports | off-grid | worst residual | riser count |
|---|---|---|---|---|---|
| spiral | viaduct | 11 | 0 | 0.000 mm | 33 |
| spiral | minimal | 12 | 0 | 0.001 mm | 32 |
| lifts | viaduct | 7 | 0 | 0.000 mm | 7 |
| lifts | minimal | 8 | 0 | 0.075 mm | 7 |
| flat run | viaduct | 3 | 0 | 0.000 mm | 5 |
| flat run | minimal | 4 | 0 | 0.001 mm | 5 |

## What each piece type asks the ladder for

| piece | style | mouth above rim | spacer | remainder the stack must make |
|---|---|---|---|---|
| start | viaduct | 0.000 | — | 0.000 |
| straight | viaduct | 0.000 | — | 0.000 |
| curveL | viaduct | 0.000 | — | 0.000 |
| curveR | viaduct | 0.000 | — | 0.000 |
| lift | viaduct | 0.000 | — | 0.000 |
| powered | viaduct | 0.000 | — | 0.000 |
| elevator | viaduct | 0.000 | — | 0.000 |
| end | viaduct | 0.000 | — | 0.000 |
| start | minimal | 0.000 | — | 0.000 |
| straight | minimal | 16.589 | SPS 16.59 | -0.001 |
| curveL | minimal | 26.199 | SPC 11.2 | 14.999 |
| curveR | minimal | 26.199 | SPC 11.2 | 14.999 |
| lift | minimal | 16.665 | SPS 16.59 | 0.075 |
| powered | minimal | 0.000 | — | 0.000 |
| elevator | minimal | 0.000 | — | 0.000 |
| end | minimal | 0.000 | — | 0.000 |

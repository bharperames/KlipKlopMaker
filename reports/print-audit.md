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
| straight (minimal) | ✔ | 55.7 | 69.0 | 159×53×30 | 1480 | 18% | 0.6 | 6427 | 7 | 6424 | 196 |
| curveL (minimal) | ✔ | 85.8 | 106 | 179×178×41 | 1777 | 6% | 0.2 | 10144 | 6 | 9946 | 0 |
| lift (minimal) | ✔ | 55.7 | 69.1 | 159×53×30 | 1481 | 18% | 0.6 | 6432 | 8 | 6405 | 196 |
| powered (minimal) | ✔ | 45.6 | 56.5 | 150×53×26 | 1548 | 20% | 0.5 | 6220 | 2 | 6214 | 0 |
| elevator (minimal) | ✔ | 328 | 406 | 150×53×116 | 3530 | 45% | 2.2 | 2480 | 699 | 3167 | 0 |
| end (minimal) | ✔ | 41.6 | 51.6 | 150×53×26 | 1164 | 15% | 0.5 | 6605 | 2 | 6599 | 0 |
| switchL (viaduct) | ✔ | 121 | 150 | 170×174×71 | 1412 | 5% | 0.4 | 13001 | 586 | 13572 | 1 |
| switchL (minimal) | ✔ | 127 | 158 | 182×178×43 | 2680 | 8% | 0.2 | 12597 | 29 | 11951 | 6 |
| bowtie_key | ✔ | 4.09 | 5.07 | 23×18×12 | 315 | 78% | 0.6 | 0 | 0 | 0 | 0 |
| gate_paddle | ✔ | 1.83 | 2.27 | 6×53×20 | 148 | 48% | 3.4 | 0 | 0 | 0 | 0 |
| spacer SPC (11.2) | ✔ | 2.42 | 3.00 | 16×18×20 | 154 | 56% | 1.3 | 131 | 0 | 70 | 0 |
| support_foot | ✔ | 7.18 | 8.90 | 42×36×24 | 1049 | 70% | 0.7 | 0 | 0 | 0 | 0 |
| riser 60 | ✔ | 11.5 | 14.2 | 17×15×69 | 118 | 45% | 4.6 | 194 | 0 | 70 | 0 |
| riser 30 | ✔ | 5.69 | 7.05 | 17×15×39 | 118 | 45% | 2.6 | 112 | 0 | 70 | 0 |
| riser 15 | ✔ | 2.79 | 3.46 | 17×15×24 | 118 | 45% | 1.6 | 70 | 0 | 70 | 0 |
| support_jog | ✔ | 11.3 | 14.0 | 62×15×24 | 686 | 73% | 1.6 | 70 | 0 | 70 | 0 |
| scenery_tower | ✔ | 114 | 141 | 51×44×115 | 1509 | 68% | 2.6 | 746 | 0 | 70 | 0 |
| scenery_patio | ✔ | 193 | 239 | 150×150×22 | 22500 | 100% | 0.1 | 0 | 0 | 0 | 0 |

# The height ladder

Grid 15 mm · foot 15 · risers 60, 30, 15 · jog 15 · spacers SPC 11.2

| design | style | supports | off-grid | worst residual | riser count |
|---|---|---|---|---|---|
| switchyard | viaduct | 5 | 0 | 0.000 mm | 4 |
| switchyard | minimal | 6 | 0 | 0.000 mm | 7 |
| spiral | viaduct | 11 | 0 | 0.000 mm | 48 |
| spiral | minimal | 12 | 0 | 0.001 mm | 49 |
| lifts | viaduct | 7 | 0 | 0.000 mm | 8 |
| lifts | minimal | 8 | 0 | 0.001 mm | 11 |
| flat run | viaduct | 3 | 0 | 0.000 mm | 5 |
| flat run | minimal | 4 | 0 | 0.000 mm | 4 |

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
| switchMain | viaduct | 0.000 | — | 0.000 |
| start | minimal | 0.000 | — | 0.000 |
| straight | minimal | 15.000 | — | 15.000 |
| curveL | minimal | 26.199 | SPC 11.2 | 14.999 |
| curveR | minimal | 26.199 | SPC 11.2 | 14.999 |
| lift | minimal | 15.000 | — | 15.000 |
| powered | minimal | 0.000 | — | 0.000 |
| elevator | minimal | 0.000 | — | 0.000 |
| end | minimal | 0.000 | — | 0.000 |
| switchMain | minimal | 30.000 | — | 30.000 |

# Riser ladders compared

Every support column in every design above, decomposed against each
candidate set. **tallest part** is what has to print standing up, and
**worst column** is how many risers one pier needs at its deepest.

| ladder | unique riser sizes | risers printed | tallest part | worst column | columns it cannot build |
|---|---|---|---|---|---|
| 120·60·30·15 (was) | 4 | 103 over 56 columns | 120 mm | 5 | 0 |
| 60·30·15 (today) | 3 | 136 over 56 columns | 60 mm | 8 | 0 |
| 60·45·30·15 | 4 | 125 over 56 columns | 60 mm | 8 | 0 |
| 30·15 | 2 | 223 over 56 columns | 30 mm | 15 | 0 |
| 15 only | 1 | 420 over 56 columns | 15 mm | 29 | 0 |

# The walking surface at the end faces

Floor height measured off the mesh at each end face, minus the deck line
the layout laid out. The washboard rides 0.6 mm above the deck line and
its pitch is snapped so a seam lands in a VALLEY, so ~0 is right and
~0.6 would mean every joint has a ridge standing in it.

| piece | style | entry face | exit face | across-channel spread | ridge at the seam |
|---|---|---|---|---|---|
| straight | viaduct | 0.128 | 0.128 | 0.122 | 0.000 |
| curveL | viaduct | 0.134 | 0.111 | 0.129 | 0.000 |
| lift | viaduct | 0.128 | 0.128 | 0.122 | 0.000 |
| straight | minimal | 0.128 | 0.128 | 0.122 | 0.000 |
| curveL | minimal | 0.134 | 0.111 | 0.129 | 0.000 |
| lift | minimal | 0.128 | 0.128 | 0.122 | 0.000 |

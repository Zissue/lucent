# Changelog

All notable changes to this project will be documented in this file.

# [0.0.4](https://github.com/toommyliu/lucent/compare/v0.0.3...v0.0.4) - (2026-10-11)

## Bug Fixes

- **lucent-dailies:** Restore Wheel of Doom inputs (#323) ([e77296a](https://github.com/toommyliu/lucent/commit/e77296aa1e776975059bc7bf748c89f9c398215c))

- **lucent-consumables:** Restore inputs for consumable selection (#322) ([7216e1c](https://github.com/toommyliu/lucent/commit/7216e1ca382de22c071ae7d307dc5dd0bdb8dff7))

- **combat-profiles:** Start attacking without waiting for monster drops (#327) ([272b0ed](https://github.com/toommyliu/lucent/commit/272b0eda4b4f5b2a041d6d93060d32be6f2b53b4))

- **combat-profiles:** Stop preflight waiting for consumable cooldowns (#328) ([6ca9c02](https://github.com/toommyliu/lucent/commit/6ca9c02bde8d14af98f2940484289d2c580b7c2e))

- Sync aura state with the client (#329) ([f4c3b51](https://github.com/toommyliu/lucent/commit/f4c3b519116eb465c5094f414f52faa0b14a87f5))


## Refactor

- **scripting/bank:** Remove bank views (#336) ([7b5f097](https://github.com/toommyliu/lucent/commit/7b5f097e9ab12b1c375066707e2039c8561a0ea4))

- **inventory:** Reuse house capacity in canAccept (#335) ([f73e971](https://github.com/toommyliu/lucent/commit/f73e971f6183b54d5b99796a2b7dda168bbd4daa))


## Features

- **scripting:** Add kind to aura events (#332) ([18fd1a6](https://github.com/toommyliu/lucent/commit/18fd1a6ba6f5a3748b981090fab5505708b37eb8))

- **scripting:** Expose item pools on LiveItem (#334) ([abc0413](https://github.com/toommyliu/lucent/commit/abc0413ff7a94be91d4ce5a764bd2c676d1372ee))

- **scripting:** Expose misc inventory capacity (#331) ([1006152](https://github.com/toommyliu/lucent/commit/10061526d13b302fdd959592935b2caa97f71094))


## Documentation

- Reorganize navigation and polish docs UI (#338) ([8aa8685](https://github.com/toommyliu/lucent/commit/8aa8685b11475cae245f7b9407a4da6f071a2e63))


# [0.0.3](https://github.com/toommyliu/lucent/compare/v0.0.2...v0.0.3) - (2026-10-10)

## Bug Fixes

- **scripting:** Close the client on exit without a confirmation (#278) ([3d20f4d](https://github.com/toommyliu/lucent/commit/3d20f4dca06333f09cd2a3a819bdbf9ee3d03e65))

- Correct item storage and capacity checks (#319) ([5a73cfa](https://github.com/toommyliu/lucent/commit/5a73cfa552b430972146d0436fa05c54d6254bcb))

- Exit combat before joining another map (#276) ([47e38ff](https://github.com/toommyliu/lucent/commit/47e38ff969801e8e97e239a2bffb50742d5e4e0d))

- Restore packet capture (#318) ([e8e9d6c](https://github.com/toommyliu/lucent/commit/e8e9d6ce9049d5d14f38b67a67f3ddb339d15d7b))

- **scripting:** Set the spawn point when starting a kill action (#300) ([4fa926e](https://github.com/toommyliu/lucent/commit/4fa926e1f0bdd4a20fd868b96ce1fafa22747e82))


## Features

- **scripting:** Expose which monsters are aggressive (#275) ([7247a6e](https://github.com/toommyliu/lucent/commit/7247a6e4e18db0641e9e8ce895a2aa5fabf0d59a))

- Support aura= stack synchronization (#320) ([ba91915](https://github.com/toommyliu/lucent/commit/ba919151c4f98c8be03e89898dc26d033cecb7f4))

- Support prereleases (#277) ([bee92c9](https://github.com/toommyliu/lucent/commit/bee92c93187d07dce3e62aba4b25e43c1080abdc))


## Documentation

- Build changelog from committed release notes (#236) ([312d822](https://github.com/toommyliu/lucent/commit/312d8223289ea479d204f9dc961dc4ad07df2e2d))


# [0.0.2](https://github.com/toommyliu/lucent/compare/v0.0.1...v0.0.2) - (2026-09-26)

## Bug Fixes

- **scripting:** Allow selected scripts missing from the catalog (#215) ([d28a2fe](https://github.com/toommyliu/lucent/commit/d28a2fe95037905f162125f807636ea880c11ebb))

- **game:** Close counter attack gaps and recover from missing signals (#220) ([3d7b6b9](https://github.com/toommyliu/lucent/commit/3d7b6b9ed64e14e3e81c2b2038354eb76c9c54ab))

- **scripting/combat:** Confirm consumable equips and respect scroll readiness (#214) ([ab7801e](https://github.com/toommyliu/lucent/commit/ab7801ec63a0831b5f40ba6a9325bbe9d792a7eb))

- **account-manager:** Disable add actions for incomplete forms (#213) ([667e8a9](https://github.com/toommyliu/lucent/commit/667e8a96a90ba2cf7eace80ff85baebabe4abf7f))

- **account-manager:** Fix clipped script filenames in picker (#211) ([ac38078](https://github.com/toommyliu/lucent/commit/ac38078cd85c2c48395ed0b6c28a510de0f7ab42))

- Hide tab close buttons while dragging (#233) ([75e7262](https://github.com/toommyliu/lucent/commit/75e726285f9787bf0a614a8953ce3c45f89aa973))

- **scripting:** Include Effect.pipe in generated types (#218) ([af785cf](https://github.com/toommyliu/lucent/commit/af785cfddb2cd569fa91efa6a1e48f5aa366110c))

- **combat-profiles:** Support profiles with empty rotations (#225) ([20e75da](https://github.com/toommyliu/lucent/commit/20e75da19b7b5b3fde2e4cace04df9488b316d5b))


## Features

- Add About window (#228) ([82d2062](https://github.com/toommyliu/lucent/commit/82d2062974ddd66ffac4a9318fc02c59b73b7dcd))

- **scripting:** Add Elders' Blood daily to @lucent/dailies (#230) ([8447df9](https://github.com/toommyliu/lucent/commit/8447df971655479199de03461675896e20fbe325))

- **scripting:** Add lucent/http module (#221) ([457bf43](https://github.com/toommyliu/lucent/commit/457bf43798fbe0acf114ce6de504919f7b40550c))

- **scripting:** Add lucent/schema module (#219) ([b937e75](https://github.com/toommyliu/lucent/commit/b937e75da36eb7d597c9cd5ba1eef3f54f0f62f1))

- **scripting:** Expose Effect.gen and Effect.raceFirst (#210) ([6328705](https://github.com/toommyliu/lucent/commit/6328705b4da1d7467ce3d94ff3a38a50530d4935))

- **scripting:** Expose animation names on combat messages (#212) ([d2d89ac](https://github.com/toommyliu/lucent/commit/d2d89ace267571e1f96e5044cb644b9f0effad6b))

- **scripting:** Expose enhancement names on items (#222) ([3c784de](https://github.com/toommyliu/lucent/commit/3c784de1481a90e68e918fa19d2b296eb7ce40e8))

- Reopen recently closed tabs (#234) ([3849324](https://github.com/toommyliu/lucent/commit/3849324df0ac42de48484b546ccb9e0522331446))


## Documentation

- Add changelog and latest platform downloads (#209) ([8c32d7e](https://github.com/toommyliu/lucent/commit/8c32d7e57fe005e73afb6e5c7fb3c202528c0dfb))

- **scripting:** Add error handling cookbook (#217) ([0bad1f4](https://github.com/toommyliu/lucent/commit/0bad1f4972308d68284dbf8b4c7f0c909241adbc))

- **scripting:** Add sound preview for script.beep (#229) ([d54ad9d](https://github.com/toommyliu/lucent/commit/d54ad9d30cdb5b52893a33eeff51cef1f3378c95))

- **scripting:** Link Effect v4 members (#226) ([4b9fa52](https://github.com/toommyliu/lucent/commit/4b9fa52bb9a81e5b87cb5bfb782cc4bd03688d8a))

- **scripting:** Use package-specific names in generated references (#231) ([fc76b46](https://github.com/toommyliu/lucent/commit/fc76b462751d283da706eddaba375526d7b95f71))


# [0.0.1](https://github.com/toommyliu/lucent/tree/v0.0.1) - (2026-09-08)
Initial release.

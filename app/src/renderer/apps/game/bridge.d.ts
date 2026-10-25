// AUTO-GENERATED FILE. DO NOT EDIT.

import type * as FlashTypes from "./Types";

declare global {
  interface Window {
    swf: {
      "auth.connectTo": (
        server: string,
      ) => FlashTypes.ConnectToSelectionResult | null;
      "auth.getServers": () => unknown[] | null;
      "auth.isLoggedIn": () => boolean;
      "auth.isTemporarilyKicked": () => boolean;
      "auth.login": (username: string, password: string) => void;
      "auth.logout": () => void;
      "bank.contains": (
        selector: FlashTypes.InventoryItemSelector,
        quantity?: number,
      ) => boolean;
      "bank.deposit": (selector: FlashTypes.InventoryItemSelector) => boolean;
      "bank.getItem": (
        selector: FlashTypes.InventoryItemSelector,
      ) => Record<string, unknown> | null;
      "bank.getItems": () => unknown[];
      "bank.getSlots": () => number;
      "bank.getUsedSlots": () => number;
      "bank.isLoaded": () => boolean;
      "bank.isOpen": () => boolean;
      "bank.loadItems": (force?: boolean) => void;
      "bank.open": () => void;
      "bank.swap": (
        inventorySelector: FlashTypes.InventoryItemSelector,
        bankSelector: FlashTypes.InventoryItemSelector,
      ) => boolean;
      "bank.withdraw": (selector: FlashTypes.InventoryItemSelector) => boolean;
      "combat.attackMonster": (selector: FlashTypes.MonsterSelector) => boolean;
      "combat.cancelAutoAttack": () => void;
      "combat.cancelTarget": () => void;
      "combat.castConsumableOnMonster": (
        selector: FlashTypes.MonsterSelector,
        expectedItemId: number,
      ) => FlashTypes.ConsumableCastDispatch | null;
      "combat.getConsumableSkillItem": () => FlashTypes.ConsumableSkillItem | null;
      "combat.getSkillCooldownRemaining": (index: number) => number;
      "combat.getTarget": () => FlashTypes.TargetInfo | null;
      "combat.hasTarget": () => boolean;
      "combat.useSkill": (
        index: string,
        selector?: FlashTypes.MonsterSelector | null,
        force?: boolean,
      ) => boolean;
      "drops.accept": (itemId: number) => boolean;
      "drops.isUsingCustomDrops": () => boolean;
      "drops.reject": (itemId: number) => boolean;
      "drops.toggleUi": () => void;
      "flash.callGameFunction": (path: string, ...args: unknown[]) => string;
      "flash.callGameFunction0": (path: string) => string;
      "flash.getArrayObject": (path: string, index: number) => string;
      "flash.getConnMcText": () => string;
      "flash.getGameObject": (path: string) => string;
      "flash.getGameObjectKey": (path: string, key: string) => string;
      "flash.getGameObjectS": (path: string) => string;
      "flash.hideConnMc": () => void;
      "flash.isConnMcBackButtonVisible": () => boolean;
      "flash.isNull": (path: string) => boolean;
      "flash.isTextFieldFocused": () => boolean;
      "flash.selectArrayObjects": (path: string, selector: string) => string;
      "flash.sendClientPacket": (packet: string, type: string) => void;
      "flash.setArrayObject": (
        path: string,
        index: number,
        value: unknown,
      ) => void;
      "flash.setGameObject": (path: string, value: unknown) => void;
      "flash.setGameObjectKey": (
        path: string,
        key: string,
        value: unknown,
      ) => void;
      "house.getItem": (
        selector: FlashTypes.InventoryItemSelector,
      ) => Record<string, unknown> | null;
      "house.getItems": () => unknown[];
      "house.getSlots": () => number;
      "house.getUsedSlots": () => number;
      "inventory.contains": (
        selector: FlashTypes.InventoryItemSelector,
        quantity?: number,
      ) => boolean;
      "inventory.equip": (
        selector: FlashTypes.InventoryItemSelector,
      ) => boolean;
      "inventory.getItem": (
        selector: FlashTypes.InventoryItemSelector,
      ) => Record<string, unknown> | null;
      "inventory.getItems": () => unknown[];
      "inventory.getMiscSlots": () => number;
      "inventory.getSlots": () => number;
      "inventory.getUsedSlots": () => number;
      "inventory.unequipConsumable": (
        selector: FlashTypes.InventoryItemSelector,
      ) => boolean;
      "inventory.use": (selector: FlashTypes.InventoryItemSelector) => boolean;
      "inventory.wear": (selector: FlashTypes.InventoryItemSelector) => boolean;
      "outfits.equip": (name: string, keepColors?: boolean) => boolean;
      "outfits.get": (name: string) => Record<string, unknown> | null;
      "outfits.getAll": () => unknown[];
      "outfits.wear": (name: string, keepColors?: boolean) => boolean;
      "player.getCell": () => string;
      "player.getCharId": () => number;
      "player.getClassName": () => string;
      "player.getData": () => Record<string, unknown> | null;
      "player.getFactions": () => unknown[];
      "player.getGender": () => string;
      "player.getGold": () => number;
      "player.getHp": () => number;
      "player.getLevel": () => number;
      "player.getMap": () => string;
      "player.getMaxHp": () => number;
      "player.getMaxMp": () => number;
      "player.getMp": () => number;
      "player.getPad": () => string;
      "player.getPosition": () => unknown[];
      "player.getState": () => number;
      "player.getUserId": () => number;
      "player.goToPlayer": (name: string) => void;
      "player.hasActiveBoost": (boostType: string) => boolean;
      "player.isAfk": () => boolean;
      "player.isLoaded": () => boolean;
      "player.isMember": () => boolean;
      "player.joinMap": (map: string, cell?: string, pad?: string) => void;
      "player.jump": (cell: string, pad?: string) => void;
      "player.rest": () => void;
      "player.walkTo": (x: number, y: number, walkSpeed?: number) => boolean;
      "quests.abandon": (questId: number) => void;
      "quests.accept": (questId: number, silent?: boolean) => boolean;
      "quests.canComplete": (questId: number) => boolean;
      "quests.complete": (
        questId: number,
        turnIns?: number,
        itemId?: number,
        special?: boolean,
      ) => void;
      "quests.get": (questId: number) => void;
      "quests.getAccepted": () => unknown[];
      "quests.getMaxTurnIns": (questId: number) => number;
      "quests.getMultiple": (questIds: string) => void;
      "quests.getTree": () => unknown[];
      "quests.isAvailable": (questId: number) => boolean;
      "quests.isInProgress": (questId: number) => boolean;
      "quests.load": (questId: number) => void;
      "quests.loadMultiple": (questIds: string) => void;
      "settings.enemyMagnet": () => void;
      "settings.infiniteRange": () => void;
      "settings.provokeCell": () => void;
      "settings.resetCustomGuild": () => void;
      "settings.resetCustomName": () => void;
      "settings.setAnimationsEnabled": (enabled: boolean) => void;
      "settings.setCollisionsEnabled": (enabled: boolean) => void;
      "settings.setCustomGuild": (name: string) => void;
      "settings.setCustomName": (name: string) => void;
      "settings.setDeathAdsVisible": (visible: boolean) => void;
      "settings.setFrameRate": (fps: number) => void;
      "settings.setLagKillerEnabled": (enabled: boolean) => void;
      "settings.setOtherPlayersVisible": (visible: boolean) => void;
      "settings.setWalkSpeed": (speed: number) => void;
      "settings.skipCutscenes": () => void;
      "shops.buy": (
        selector: FlashTypes.ShopItemSelector,
        quantity?: number,
      ) => void;
      "shops.canBuyItem": (
        selector: FlashTypes.ShopItemSelector,
        quantity?: number,
      ) => boolean;
      "shops.close": (shopId?: number) => boolean;
      "shops.enhance": (
        selector: FlashTypes.ShopItemSelector,
        itemId: number,
      ) => boolean;
      "shops.getItem": (
        selector: FlashTypes.ShopItemSelector,
      ) => Record<string, unknown> | null;
      "shops.getMaxBuyQuantity": (
        selector: FlashTypes.ShopItemSelector,
      ) => number;
      "shops.isMergeShop": () => boolean;
      "shops.isOpen": (shopId?: number) => boolean;
      "shops.load": (shopId: number) => void;
      "shops.loadArmorCustomize": () => void;
      "shops.loadHairShop": (shopId: number) => void;
      "shops.sell": (
        selector: FlashTypes.InventoryItemSelector,
        quantity?: number,
      ) => boolean;
      "tempInventory.contains": (
        selector: FlashTypes.InventoryItemSelector,
        quantity?: number,
      ) => boolean;
      "tempInventory.getItem": (
        selector: FlashTypes.InventoryItemSelector,
      ) => Record<string, unknown> | null;
      "tempInventory.getItems": () => unknown[];
      "world.getAvailableMonsterMapIds": () => number[];
      "world.getCellPads": () => unknown[];
      "world.getCells": () => unknown[];
      "world.getMapItem": (itemId: number) => void;
      "world.getMonster": (
        selector: FlashTypes.MonsterSelector,
      ) => Record<string, unknown> | null;
      "world.isActionAvailable": (gameAction: string) => boolean;
      "world.isCellReady": (cell: string, pad?: string) => boolean;
      "world.isLoaded": () => boolean;
      "world.isMonsterAvailable": (monsterMapId: number) => boolean;
      "world.loadSwf": (swf: string) => void;
      "world.reload": () => void;
      "world.requestMonsterDrops": (monsterMapId: number) => boolean;
      "world.setSpawnPoint": (cell?: string, pad?: string) => void;
    };
    onConnection?: (status: string) => void;
    onDebug?: (message: string) => void;
    onExtensionResponse?: (packet: string) => void;
    onLoaded?: () => void;
    onProgress?: (percent: number) => void;
    packetFromClient?: (packet: string) => void;
    packetFromServer?: (packet: string) => void;
  }
}

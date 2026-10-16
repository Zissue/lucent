import type { Monster } from "@lucent/game";

const cellKey = (cell: string): string => cell.trim().toLowerCase();
const transitionCells = new Set(["", "blank", "wait"]);

export const combatExitCells = (
  cells: readonly string[],
  monsters: readonly Pick<Monster, "aggressive" | "cell">[],
  currentCell: string,
): readonly string[] => {
  const aggressiveCells = new Set(
    monsters
      .filter((monster) => monster.aggressive)
      .map((monster) => cellKey(monster.cell)),
  );
  const occupiedCells = new Set(
    monsters.map((monster) => cellKey(monster.cell)),
  );
  const current = cellKey(currentCell);
  const rank = (cell: string): number =>
    cellKey(cell) === current ? 0 : occupiedCells.has(cellKey(cell)) ? 2 : 1;

  return cells
    .filter(
      (cell) =>
        !transitionCells.has(cellKey(cell)) &&
        !aggressiveCells.has(cellKey(cell)),
    )
    .toSorted((left, right) => rank(left) - rank(right));
};

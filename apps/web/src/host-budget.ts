import { MIB, validBudget } from "../../../packages/provisioning/src/capacity";
export function storageSize(bytes: number) {
  const units = ["MiB", "GiB", "TiB", "PiB"];
  let size = bytes / MIB,
    unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[unit]}`;
}
/** A logarithmic slider for exploration, paired with an unconstrained exact MiB input. */
export function budgetControl(id: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const slider = document.getElementById(id + "-slider") as HTMLInputElement;
  const output = document.getElementById(id + "-value") as HTMLOutputElement;
  let capacity = 2048;
  const scale = () =>
    Math.max(
      2,
      capacity,
      validBudget(input.valueAsNumber * MIB) ? input.valueAsNumber : 1,
    );
  function sync() {
    const value = input.valueAsNumber * MIB,
      valid = validBudget(value);
    output.textContent = valid
      ? storageSize(value)
      : "Enter a size of at least 1 MiB.";
    output.dataset.invalid = String(!valid);
    if (valid) {
      slider.value = String(
        Math.round(
          (Math.log(Math.max(1, input.valueAsNumber)) / Math.log(scale())) *
            1000,
        ),
      );
      slider.setAttribute("aria-valuetext", storageSize(value));
    }
  }
  input.addEventListener("input", sync);
  slider.addEventListener("input", () => {
    const value = Math.max(
      1,
      Math.round(scale() ** (Number(slider.value) / 1000)),
    );
    input.value = String(value);
    sync();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  sync();
  return {
    setCapacity(bytes: number) {
      capacity = Math.max(1, Math.floor(bytes / MIB));
      sync();
    },
  };
}

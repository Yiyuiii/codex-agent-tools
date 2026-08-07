import path from "node:path";

export function isAbsoluteOnAnyPlatform(value) {
  return (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  );
}

export function isSafeRelativeLaunchPath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.trim() === value &&
    !/[\0\r\n]/u.test(value) &&
    !/^[A-Za-z]:/u.test(value) &&
    !isAbsoluteOnAnyPlatform(value) &&
    !value.split(/[\\/]/u).includes("..")
  );
}

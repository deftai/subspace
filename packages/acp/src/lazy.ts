/**
 * A field computed the first time it is read. Until then it is an accessor;
 * reading it (or assigning to it) replaces the accessor with an ordinary
 * writable, enumerable data property on that object. So a snapshot can defer
 * copying until someone looks, and still behave like a plain object: reading
 * twice gives the same value, the value is the snapshot's own, and assignment
 * works as it does on any other field.
 */
export function defineLazy<T extends object, K extends PropertyKey>(target: T, key: K, read: () => unknown): void {
  Object.defineProperty(target, key, {
    get(this: object) {
      const value = read();
      // On a frozen or sealed object the accessor cannot be replaced: give the value each time.
      Reflect.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
    set(this: object, value: unknown) {
      Reflect.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
    },
    enumerable: true,
    configurable: true,
  });
}

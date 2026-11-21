const invalidArguments = (): never => {
	throw new Error("invalid_arguments");
};

const dataProperty = (object: object, key: string): unknown => {
	const property = Object.getOwnPropertyDescriptor(object, key);
	if (!property?.enumerable || !Object.hasOwn(property, "value"))
		return invalidArguments();
	return property.value;
};

// Copy plain data without calling toJSON, invoking getters, or silently
// dropping object fields whose values cannot be represented.
const copyJsonData = (value: unknown, ancestors: Set<object>): unknown => {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return value;
	if (typeof value !== "object" || ancestors.has(value))
		return invalidArguments();
	ancestors.add(value);
	try {
		const prototype = Object.getPrototypeOf(value);
		const keys = Reflect.ownKeys(value);
		if (Array.isArray(value)) {
			if (prototype !== Array.prototype || keys.length !== value.length + 1)
				return invalidArguments();
			const items = Array.from({ length: value.length }, (_, index) =>
				copyJsonData(dataProperty(value, String(index)), ancestors),
			);
			return Object.setPrototypeOf(items, null);
		}
		if (prototype !== null && prototype !== Object.prototype)
			return invalidArguments();
		const result: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			if (typeof key !== "string") return invalidArguments();
			const field = dataProperty(value, key);
			if (field !== undefined) result[key] = copyJsonData(field, ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
};

/** The authorized payload must represent the prepared arguments as JSON data. */
export const serializeApprovalInput = (value: unknown): string => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalidArguments();
	try {
		return JSON.stringify(copyJsonData(value, new Set()));
	} catch {
		return invalidArguments();
	}
};

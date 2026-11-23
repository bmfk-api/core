import dns from "dns";

type SyncOptions = {
	fillOnlyWhenNull?: boolean;          // по умолчанию true
	resetOnTypeMismatch?: boolean;       // для примитивов/необъектов — заменить на дефолт (true для array items)
	repairArrayItems?: "coerce";         // единственный режим сейчас: приводим элементы
	coerceArrayFromObject?: "values" | "numericKeys" | "wrap" | "off";
	// values — брать Object.values(obj) как элементы массива (по умолчанию)
	// numericKeys — собирать по ключам "0","1",...
	// wrap — если tmpl объект, делаем [obj]
	// off — не трогаем (оставляем объект как есть)
};

export type TValidatorType = "string" | "number" | "boolean" | "date" | "array" | "object" | "email" | "phone"

export interface IStructureOptions {
	optional?: boolean
	skip_validation?: boolean,
	default?: any
	values?: any
	regex?: string,
	min?: number,
	max?: number
	details?: string
	type?:string
	ignore_in_documentation?: boolean
}

export interface IValidatorOptions {
	min?: number,
	max?: number,
	type?: TValidatorType,
	regex?: RegExp
}

export interface IValidaotrType {
	name: string,
	type: TValidatorType
	optional?: boolean,
	arrayType?: IValidaotrType,
}

export enum ValidationReport {
	OK = 1,
	VALUE_IS_NULL = 2,
	TYPE_MISSMATCH = 3,
	VALUE_TOO_BIG = 4,
	VALUE_TOO_SHORT = 5,
	VALUE_INCORRECT = 6
}

/** ---------------------------
 *  БАЗОВЫЕ УТИЛИТЫ
 *  --------------------------- */
type WidenLiteral<T> =
  T extends string ? string :
  T extends number ? number :
  T extends boolean ? boolean :
  T;

type WidenLiterals<T> = {
  [K in keyof T]: T[K] extends readonly (infer R)[]
    ? readonly WidenLiteral<R>[]
    : T[K] extends (infer R)[]
      ? WidenLiteral<R>[]
      : T[K] extends object
        ? WidenLiterals<T[K]>
        : WidenLiteral<T[K]>;
};

type DeepMutable<T> =
  T extends ReadonlyArray<infer U> ? DeepMutable<U>[] :
  T extends Array<infer U>        ? DeepMutable<U>[] :
  T extends (...args: any[]) => any ? T :
  T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } :
  T;

type IsNever<T> = [T] extends [never] ? true : false;
type Or<A, B> = A extends true ? true : (B extends true ? true : false);

/** ---------------------------
 *  ЧИСТКА МЕТА-КЛЮЧЕЙ
 *  --------------------------- */
type CleanFields<T> = WidenLiterals<{
  [K in keyof T as K extends `$__${string}` ? never : K]: T[K];
}>;

/** ---------------------------
 *  OPTIONAL-ДЕТЕКТ (по исходному T)
 *  --------------------------- */
type HasOptional<T, K extends string> = Or<
  `$__${K}_optional` extends keyof T
    ? T[`$__${K}_optional`] extends true ? true : false
    : false,
  `$__${K}` extends keyof T
    ? T[`$__${K}`] extends { optional: true } ? true : false
    : false
>;

type ExtractOptionalFieldNames<T> = {
  [K in (keyof T & string) as HasOptional<T, K> extends true ? K : never]: true;
};
type OptionalFields<T> = keyof ExtractOptionalFieldNames<T> & string;

/** ---------------------------
 *  ENUM VALUES (по исходному T)
 *  --------------------------- */
// поддерживаем: readonly [...], обычный массив, а также map-объект вида {X:"x",...} as const
type ValuesArr<T, K extends string> =
  `$__${K}_values` extends keyof T
    ? T[`$__${K}_values`] extends readonly (infer V)[] ? readonly V[] :
      T[`$__${K}_values`] extends (infer V)[] ? readonly V[] :
      T[`$__${K}_values`] extends Record<string, infer V> ? readonly V[] :
      never
  : `$__${K}` extends keyof T
    ? T[`$__${K}`] extends { values: readonly (infer V)[] } ? readonly V[] :
      T[`$__${K}`] extends { values: (infer V)[] } ? readonly V[] :
      T[`$__${K}`] extends { values: Record<string, infer V> } ? readonly V[] :
      never
  : never;

type ExtractEnumValues<T> = {
  [K in (keyof T & string) as IsNever<ValuesArr<T, K>> extends true ? never : K]:
    ValuesArr<T, K> extends ReadonlyArray<infer V> ? V : never;
};

type EnumFieldNames<T> = keyof ExtractEnumValues<T> & string;
type EnumFieldValues<T> = ExtractEnumValues<T>;

/** ---------------------------
 *  ОБРАБОТКА ЗНАЧЕНИЯ ПОЛЯ (рекурсия с мета)
 *  --------------------------- */
type FieldOriginal<T, K extends PropertyKey> =
  K extends keyof T ? T[K] : never;

// рекурсируем в исходный под-тип с его $__
type ProcessValue<T, K extends keyof CleanFields<T>> =
  FieldOriginal<T, K> extends ReadonlyArray<infer Item>
    ? Item extends object
      ? ValidationModel<Item>[]
      : WidenLiteral<Item>[]
  : FieldOriginal<T, K> extends Array<infer Item>
    ? Item extends object
      ? ValidationModel<Item>[]
      : WidenLiteral<Item>[]
  : FieldOriginal<T, K> extends (...a: any[]) => any
    ? FieldOriginal<T, K>
  : FieldOriginal<T, K> extends object
    ? ValidationModel<FieldOriginal<T, K>>
    : WidenLiteral<FieldOriginal<T, K>>;

/** ---------------------------
 *  ОСНОВНОЙ ТИП
 *  --------------------------- */
export type ValidationModel<T> = DeepMutable<{
  // Опциональные
  [K in keyof CleanFields<T> as K extends OptionalFields<T> ? K : never]?:
    K extends EnumFieldNames<T>
      ? EnumFieldValues<T>[K]
      : ProcessValue<T, K>;
} & {
  // Обязательные
  [K in keyof CleanFields<T> as K extends OptionalFields<T> ? never : K]:
    K extends EnumFieldNames<T>
      ? EnumFieldValues<T>[K]
      : ProcessValue<T, K>;
}>;

/** ---------------------------
 *  (необязательно) ассерт для самопроверки
 *  --------------------------- */
// type Equal<A,B> = (<X>()=>X extends A?1:2) extends (<X>()=>X extends B?1:2) ? true : false;
// type Assert<T extends true> = T;


export class Validator {

	static validateObject(fields: string[], object: any): boolean {
		if (!object || typeof object !== "object")
			return false
		for (let i of fields) {
			if (!(i in object) || object[i] === undefined)
				return false;
		}
		return true;
	}

	static documentStructure(structure: any): Record<string, any> | undefined {
		const params: Record<string, any> = {};
		if (!structure || typeof structure !== "object")
			return;

		for (let i in structure) {
			if (i.startsWith("$__")) // description
				continue;

			let structureOptions: IStructureOptions = Validator.parseStructureOptions(i, structure);
			let childs: Record<string, any> | undefined = undefined;
			if (typeof structure[i] === "object"){
				if(!structureOptions || !structureOptions.ignore_in_documentation)
					childs = this.documentStructure(structure[i]);
				else
					continue;
			}

			params[i] = {
				...structureOptions,
				childs: childs
			}
		}

		return params

	}


	static boundFromKey(structure: Record<string, any>, name: string): number | undefined {
		const v = structure[name]
		if (v === undefined || v === null || v === "" || typeof v === "boolean")
			return undefined
		const n = Number(v)
		return isNaN(n) ? undefined : n
	}

	/**
	 * Number fields whose sample is not 0 and that have no min/max: before 1.0 such a sample was a bound
	 * (10 → at most 10, -5 → at least 5). Now it is only the type; this lists them so it isn't lost silently.
	 */
	static numericSamples(structure: any, parentPath = ""): string[] {
		if (!structure || typeof structure !== "object") return [];
		if (Array.isArray(structure)) return Validator.numericSamples(structure[0], parentPath);
		const found: string[] = [];
		for (const key of Object.keys(structure)) {
			if (key.startsWith("$__")) continue;
			const value = structure[key];
			if (typeof value === "number" && value !== 0) {
				const o = Validator.parseStructureOptions(key, structure);
				if (o.min === undefined && o.max === undefined) found.push(`${parentPath}${key} (${value})`);
			} else if (value && typeof value === "object") {
				found.push(...Validator.numericSamples(value, `${parentPath}${key}.`));
			}
		}
		return found;
	}

	static parseStructureOptions(key: string, structure: Record<string, any>): IStructureOptions {
		let k = '$__' + key
		let s_options = structure[k] as IStructureOptions;

		if (!s_options)
			s_options = {}

		if (typeof s_options === "string")
			s_options = { details: s_options }

		k = k + "_"

		

		// Bounds as separate keys: $__‹key›_min / $__‹key›_max. The object form ($__‹key›: {min, max})
		// wins when both are given.
		if (s_options.min == undefined || isNaN(s_options.min))
			s_options.min = Validator.boundFromKey(structure, k + "min") ?? s_options.min

		if(s_options.ignore_in_documentation === undefined && structure[k+"ignore_in_documentation"]!==undefined)
			s_options.ignore_in_documentation = structure[k+"ignore_in_documentation"]

		// Allowed-values enum. Two conventions, both surfaced into the documented options so the
		// docs show what a field accepts (previously only validateStructure read these):
		//   1) $__‹key›_values: ["a","b"]   2) the field value itself as a comma list "a,b,c"
		if (s_options.values === undefined && structure[k + "values"] !== undefined)
			s_options.values = structure[k + "values"]
		if (s_options.values === undefined && typeof structure[key] === "string" && structure[key].includes(","))
			s_options.values = structure[key].split(",").map((v: string) => v.trim()).filter((v: string) => v.length > 0)

		if (s_options.min !== undefined && isNaN(s_options.min))
			s_options.min = undefined

		if (s_options.max == undefined || isNaN(s_options.max))
			s_options.max = Validator.boundFromKey(structure, k + "max") ?? s_options.max

		if (s_options.max !== undefined && isNaN(s_options.max))
			s_options.max = undefined

		if(s_options && !s_options.type){
			let type: string = typeof structure[key];
			if (type === "object" && Array.isArray(structure[key]))
				type = "array";
			if (structure[key] === "@")
				type = "email";
			s_options.type=type
		}


		return {
			...s_options,
			optional: s_options.optional === undefined ? structure[k + 'optional'] ?? false : s_options.optional,
			default: s_options.default === undefined ? structure[k + 'default'] ?? undefined : s_options.default,
			regex: s_options.regex === undefined ? structure[k + 'regex'] ?? undefined : s_options.regex,
			details: s_options.details === undefined ? structure[k + 'details'] ?? undefined : s_options.details,

		}
	}


	static async validateStructure(structure: any, object: any, level: number = 0, parentPath: string = ""): Promise<string[] | undefined> {

		if (!structure)
			return;

		if (!object)
			return ["no data"]

		if (typeof structure !== "object") {
			if (typeof object === "object")
				return ["wrong datatype"]
			if (typeof object !== typeof structure)
				return ["datatype missmatch"]
			return;
		}

		if (typeof structure === "function") {
			let result = ['can`t validate data'];
			try { result = await structure(object) } catch (e) { }
			return result;
		}

		let errors = [];
		let foundKeys = [];
		for (let i in structure) {

			if (i.startsWith("$__")) {
				// ignore system fields
				foundKeys.push(i);
				continue;
			}

			if (structure[i] === null) {
				// optional
				foundKeys.push(i);
				continue;
			}

			if(typeof structure[i] === "object" && Array.isArray(structure[i]) && structure[i].length===0){
				// empty array - skip validation
				foundKeys.push(i);
				continue;
			}

			if(typeof structure[i] === "object" && Object.keys(structure[i]).length===0){
				// empty object - skip validation
				foundKeys.push(i);
				continue;
			}

			let structureOptions: IStructureOptions = Validator.parseStructureOptions(i, structure);

			if (structureOptions.skip_validation) {
				foundKeys.push(i);
				continue;
			}

			if ((object[i] === null || object[i] === undefined || !(i in object)) && structure[i] !== null && structure[i] !== undefined) {
				if (structureOptions.default) {
					object[i] = structureOptions.default
				} else {
					if (structureOptions.optional) {
						foundKeys.push(i)
						continue;
					} else {
						if (Array.isArray(object) && !isNaN(parseInt(`${i}`))) {
							const p = parentPath.length > 0 ? parentPath.slice(0, -1) : parentPath
							errors.push("no item for '" + p + "[" + i + "]'")
						} else {
							errors.push("no field '" + parentPath + i + "'")
						}
						continue;
					}
				}
			}

			if (structureOptions.optional && typeof object[i] === "object" && object[i] !== null) {
				const isEmpty = Array.isArray(object[i]) ? object[i].length === 0 : Object.keys(object[i]).length === 0;
				if (isEmpty) {
					foundKeys.push(i);
					continue;
				}
			}

			if ((object[i] === null || object[i] === undefined)) {
				if (structure[i] === null || structure[i] === undefined) {
					foundKeys.push(i);
					continue;
				} else {
					errors.push("no field '" + parentPath + i + "'")
					continue;
				}
			}

			if (typeof structure[i] === "number" && typeof object[i] === "string") {

				let num = parseInt(object[i]);
				if (object[i].includes("."))
					num = parseFloat(object[i]);

				// attach default if possible
				if (isNaN(num))
					num = structureOptions.default !== undefined ? structureOptions.default : NaN;

				if(isNaN(num))
					errors.push("wrong value for field '" + parentPath + i + "', expected number got " + object[i]);
				else
					object[i] = num;
			}

			if(typeof structure[i]==="boolean"){
				if(typeof object[i] === "number"){
					if(object[i]===1)
						object[i]=true
					if(object[i]===0)
						object[i]=false
				}
				if(typeof object[i] ==="string"){
					if(object[i].trim().toLowerCase()==="true")
						object[i]=true
					if(object[i].trim().toLowerCase()==="false")
						object[i]=false
				}
			}

			if (typeof object[i] !== typeof structure[i])
				errors.push("wrong datatype for field '" + i + "' expected " + typeof structure[i] + " got " + typeof object[i])

			if (typeof structure[i] === "object" || typeof structure[i] === "function") {

				if (typeof object[i] !== "object") {
					errors.push("wrong type for: " + parentPath + i)
				} else {

					if (Array.isArray(structure[i]) && !Array.isArray(object[i])) {
						errors.push("array expected for " + parentPath + i)
					} else {

						const result = await this.validateStructure(structure[i], object[i], level++, parentPath + i + ".");
						if (result) {
							for (let j of result)
								errors.push(j);
						}
					}
				}
			}

			if (typeof structure[i] === "string" && structure[i].includes(",")) {
				// expected values
				const expected = structure[i].split(",").map((v: string) => v.trim().toLowerCase());
				if (expected.length) {
					const value = object[i].toString().toLowerCase().trim();
					if (value.length === 0)
						errors.push("empty value for field '" + parentPath + i + "'");
					else if (expected.indexOf(value) === -1)
						errors.push("wrong value for field '" + parentPath + i + "', expected " + expected.join(", ") + " got: " + value);
				}
			}

			if (structure['$__' + i + "_values"])
				structureOptions.values = structure['$__' + i + "_values"]


			if (Array.isArray(structureOptions.values) && structureOptions.values.length) {
				const checkOneValue = (val: any): string | null => {
					if (structureOptions.values.includes(val))
						return null;
					let caseValue = null;
					for (const av of structureOptions.values) {
						if (av === null || av === undefined)
							continue;
						if ((av + "").toLowerCase().trim() === (val + "").toLowerCase().trim()) {
							caseValue = av;
							break;
						}
						if (typeof av === "object") {
							for (const key of Object.keys(av)) {
								if ((av[key] + "").toLowerCase().trim() === (val + "").toLowerCase().trim()) {
									caseValue = av[key];
									break;
								}
							}
						}
					}
					return "wrong value for field '" + parentPath + i + "'" + (caseValue ? ", check case for: " + caseValue : "");
				};

				if (Array.isArray(object[i])) {
					for (const item of object[i]) {
						const err = checkOneValue(item);
						if (err) errors.push(err);
					}
				} else {
					// apply the default only when the incoming value is empty,
					// otherwise a provided value would always be overwritten by the default.
					const isEmpty = object[i] === "" || object[i] === null || object[i] === undefined;
					if (isEmpty && structureOptions.default !== undefined && structureOptions.values.includes(structureOptions.default)) {
						object[i] = structureOptions.default;
						continue;
					}
					const err = checkOneValue(object[i]);
					if (err) errors.push(err);
				}
			}

			
			if (typeof structure[i] === "string" && structureOptions.regex) {
				// expected regex — skip when the field is optional and the value is empty,
				// otherwise an optional empty input would always fail the mask.
				const val = object[i];
				const isEmpty = val === "" || val === null || val === undefined;
				if (!(structureOptions.optional && isEmpty)) {
					const reg = new RegExp(structureOptions.regex);
					if (reg.test(val) === false)
						errors.push("wrong value for field '" + parentPath + i + "', false mask for: >" + val + "<");
				}
			}

			// sep
			if (typeof structure[i] === "string" && (structure[i] === "@" || structure[i] === "email")) {
				// check for email
				const value = object[i].toString().toLowerCase().trim() as string;
				if (value.replaceAll(/^[\w-\.]+@([\w-]+\.)+[\w-]{2,6}$/g, "").length !== 0)
					errors.push("wrong value for field '" + parentPath + i + "', expected email got: " + object[i]);

				const domain = value.split("@")[1];
				try {
					await dns.promises.resolveMx(domain);
				} catch (e) {
					return ["MX Domain is incorrect"]
				}

			}

			if (typeof structure[i] === "number") {

				if (typeof object[i] === "string") {
					if (object[i].indexOf(".") !== -1)
						object[i] = parseFloat(object[i])
					else
						object[i] = parseInt(object[i])
				}

				if (isNaN(object[i]))
					errors.push("wrong value for field '" + parentPath + i + "', expected number got " + object[i]);

				// The sample value is only the type: bounds are min/max ($__X_min, $__X_max or $__X: { min, max }).
			}


			if (typeof structure[i] === "number" && structureOptions.min !== undefined && !isNaN(structureOptions.min)) {
				if (object[i] < structureOptions.min)
					errors.push("value for field '" + parentPath + i + "' is too small, expected more than " + structureOptions.min + " got: " + object[i]);
			}


			if (typeof structure[i] === "number" && structureOptions.max !== undefined && !isNaN(structureOptions.max)) {
				if (object[i] > structureOptions.max)
					errors.push("value for field '" + parentPath + i + "' is too big, expected less than " + structureOptions.max + " got: " + object[i]);
			}

			if(typeof structure[i] === "string" && !structureOptions.optional){
				let min = structureOptions.min || 1;
				
				if(isNaN(min) || min<1)
					min = 1;
				
				if(object[i].toString().trim().length<min)
					errors.push("empty value for field '" + parentPath + i + "'");
			}

			// Check string length
			if (typeof object[i] === "string" && structureOptions.min !== undefined && !isNaN(structureOptions.min)) {
				// check for min value
				if (object[i].length < structureOptions.min)
					errors.push("value length for field '" + parentPath + i + "' is too small, expected more than " + structureOptions.min + " got: " + object[i].length);
			}

			if (typeof object[i] === "string" && structureOptions.max !== undefined && !isNaN(structureOptions.max)) {
				// check for max value
				if (object[i].length > structureOptions.max)
					errors.push("value length for field '" + parentPath + i + "' is too big, expected less than " + structureOptions.max + " got: " + object[i].length);
			}


			foundKeys.push(i);
		}



		if (errors.length > 0)
			return errors;

		return;

	}


	static filterStructure(structure: any, object: any) {
		if (!structure || !object)
			return;
		if (typeof structure !== "object" || typeof object !== "object")
			return;

		// do not check arrays
		if (Array.isArray(structure)) {
			if (!Array.isArray(object))
				return;
			if (structure.length < 1)
				return;
			for (let i of object)
				this.filterStructure(structure[0], i)
			return;
		}

		
		for (let key of Object.keys(object)) {
			if (!(key in structure)) {
				delete object[key];
				continue;
			}

			// remove special keys
			if (key.startsWith("$__"))
				delete object[key]

			if (typeof object[key] === "object")
				this.filterStructure(structure[key], object[key]);
		}
	}


	static isPlainObject(v: any) {
		return v !== null && typeof v === "object" && !Array.isArray(v);
	}
	static clone<T>(v: T): T {
		if (typeof structuredClone === "function") return structuredClone(v as any);
		return JSON.parse(JSON.stringify(v));
	}


	/**
	* Repair, not replace + сохранение порядка:
	* - ВОЗВРАЩАЕТ НОВЫЙ узел, собранный в порядке ключей structure
	* - Чинит типы и недостающие поля по структуре
	* - Массивы: приводит элементы к шаблону, не удаляет
	* - Восстанавливает все мета-ключи `$__*`
	* - Подставляет default при null/undefined, если поле не optional (или skip_validation)
	*/
  static syncStructure(structure: any, node: any):any {
    if (structure === null || typeof structure !== "object") return node;

	if(structure && typeof structure ==="object" && Object.keys(structure).length===0)
		return node;

    // ======== МАССИВЫ ========
    if (Array.isArray(structure)) {
      const tmpl = structure[0];

      // Коэрция: объект с числовыми ключами -> массив
      if (!Array.isArray(node) && this.isPlainObject(node)) {
        const numericKeys = Object.keys(node)
          .filter((k) => String(+k) === k)
          .map((k) => +k)
          .sort((a, b) => a - b);

        const items =
          numericKeys.length > 0
            ? numericKeys.map((i) => node[String(i)])
            : Object.values(node);

        // Собираем новый массив, чиним каждый элемент
        return items.map((it) => this.syncStructure(tmpl, it));
      }

      if (!Array.isArray(node)) return node;

      if (tmpl === undefined) return node;

      // Не трогаем порядок элементов — приводим каждый к шаблону
      const out: any[] = new Array(node.length);
      for (let i = 0; i < node.length; i++) {
        const item = node[i];

        if (item === null || item === undefined) {
          out[i] = this.syncStructure(tmpl, this.clone(tmpl));
        } else if (this.isPlainObject(tmpl) && this.isPlainObject(item)) {
          out[i] = this.syncStructure(tmpl, item);
        } else if (Array.isArray(tmpl) && Array.isArray(item)) {
          out[i] = this.syncStructure(tmpl, item);
        } else if (!this.isPlainObject(tmpl) && !Array.isArray(tmpl)) {
          // Примитивный шаблон — это МАРКЕР ТИПА, а не значение по умолчанию:
          // "" = любая строка, 0 = любое число, true/false = любой boolean.
          // Значение элемента сохраняем; коэрцим только если тип не совпал с маркером.
          const wantType = typeof tmpl; // "string" | "number" | "boolean"
          if (typeof item === wantType) {
            out[i] = item;
          } else if (wantType === "string" || wantType === "number" || wantType === "boolean") {
            const converted = this.convertToType<any>(item, wantType);
            // convertToType returns NaN for unparseable numbers — treat that (and null) as
            // "not convertible" and fall back to the template marker's zero-value.
            const bad = converted === null || (wantType === "number" && Number.isNaN(converted));
            out[i] = bad ? this.clone(tmpl) : converted;
          } else {
            out[i] = item;
          }
        } else {
          // Настоящее несовпадение контейнеров (шаблон — объект/массив, элемент — нет):
          // коэртируем к форме шаблона (НЕ удаляем).
          out[i] = this.syncStructure(tmpl, this.clone(tmpl));
        }
      }
      return out;
    }




    // ======== ОБЪЕКТЫ ========
    // Собираем НОВЫЙ объект в точном порядке ключей структуры
    const out: any = {};
    const src = this.isPlainObject(node) ? node : {};

    // Проходим по ключам структуры в их исходном порядке
    for (const k of Object.keys(structure)) {
      const sv = structure[k];

      // (a) Мета-ключи всегда копируем из структуры (сохраняем их позицию)
      if (k.startsWith("$__")) {
        out[k] = this.clone(sv);
        continue;
      }

      const has = Object.prototype.hasOwnProperty.call(src, k);
      const ov = has ? src[k] : undefined;
      const { optional, skip_validation, default: def } = this.parseStructureOptions(k, structure);


      // (b) Ключ отсутствует: вставляем дефолт из структуры (и чиним вложенность)
      if (!has) {
        if (sv && typeof sv === "object") {
          out[k] = this.syncStructure(sv, this.clone(sv));
        } else {
          out[k] = this.clone(sv);
        }
        continue;
      }

      // (c) Значение null/undefined: подставить default, если он есть и поле НЕ optional;
      //    иначе — если (!optional || skip_validation) — берём из структуры (и чиним вложенность)
      if (ov === null || ov === undefined) {
        if (def !== undefined && !optional) {
          out[k] = this.clone(def);
        } else if (!optional || skip_validation) {
          out[k] = sv && typeof sv === "object"
            ? this.syncStructure(sv, this.clone(sv))
            : this.clone(sv);
        } else {
          out[k] = ov; // оставить null/undefined как есть
        }
        continue;
      }

      // (d) Контейнеры правим рекурсивно (это гарантирует восстановление мета и порядок внутри)
      if (sv && typeof sv === "object") {
        out[k] = this.syncStructure(sv, ov);
        continue;
      }

      // (e) Примитивы непустые — сохраняем пользовательское значение
      out[k] = ov;
    }

    // Лишние ключи из исходного объекта НЕ копируем -> они пропадают (фильтрация)
    return out;
  }

 

	static convertToType<T>(value: any, type: "string" | "number" | "boolean" | "date"): T | null {
		if (value === null || value === undefined)
			return null;

		if (type === "string") {
			if (typeof value === "object") {
				let result = null
				try { result = JSON.stringify(value); } catch (e) { }
				if (result !== null)
					return result as T
			}
			return value + "" as T
		}

		if (type === "boolean") {
			if (typeof value === "boolean")
				return value as T
			if (typeof value === "number")
				return value > 0 as T
			if (typeof value === "object")
				return false as T
			if (typeof value === "string")
				return (value.toLowerCase() === "true") as T
		}

		if (type === "date") {
			if (typeof value === "string" || typeof value === "number")
				return new Date(value) as T
			return null;
		}

		// number
		if (typeof value === "number")
			return value as T

		if (typeof value === "object")
			return 0 as T

		const num = parseInt(value + "");
		return num as T
	}

	static validateValue(value: string | number | boolean, opt?: IValidatorOptions): ValidationReport {
		if (value === undefined || value === null)
			return ValidationReport.VALUE_IS_NULL;
		if (!opt)
			return ValidationReport.OK;


		if (!opt.type)
			opt.type = "string";

		if (opt.type === "boolean") {
			if (typeof value === "boolean")
				return ValidationReport.OK;
			if (typeof value === "number" && (value === 1 || value === 0))
				return ValidationReport.OK
			return ValidationReport.TYPE_MISSMATCH
		}

		if (opt.type === "number") {
			if (typeof value !== "number")
				return ValidationReport.TYPE_MISSMATCH
			if (opt.max !== undefined && value > opt.max)
				return ValidationReport.VALUE_TOO_BIG
			if (opt.min !== undefined && value < opt.min)
				return ValidationReport.VALUE_TOO_SHORT
			return ValidationReport.OK;
		}

		if (typeof value !== "string")
			return ValidationReport.TYPE_MISSMATCH

		if (opt.max !== undefined && value.length > opt.max)
			return ValidationReport.VALUE_TOO_BIG

		if (opt.min !== undefined && value.length < opt.min)
			return ValidationReport.VALUE_TOO_SHORT

		if (opt.type === "email" && !opt.regex) {
			opt.regex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,6}$/g;
		}

		if (opt.regex) {
			const globalRegex = new RegExp(opt.regex.source, opt.regex.flags.includes('g') ? opt.regex.flags : opt.regex.flags + 'g');
			const tmp = value.replaceAll(globalRegex, "");
			if (tmp.length !== 0)
				return ValidationReport.VALUE_INCORRECT
		}



		return ValidationReport.OK;
	}
}
// Minimal JSON-Schema subset used to check model-supplied tool arguments before anything runs.
//
// Models regularly send "50" for an integer, "true" for a boolean, null for an optional field or a
// single string where an array is expected. With coercion on, those harmless slips are repaired
// instead of failing the step; anything else is reported as a precise error the model can act on.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @returns {{ok: boolean, value: any, errors: string[]}} */
export function validateArguments(schema, input, { coerce = true } = {}) {
  const errors = [];
  const value = check(schema ?? {}, input, '', errors, coerce);
  return { ok: errors.length === 0, value, errors };
}

function check(schema, value, at, errors, coerce) {
  const where = at || 'đối số';
  switch (schema.type) {
    case 'object': {
      if (!isObject(value)) { errors.push(`${where} phải là object JSON`); return value; }
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (value[key] !== undefined && !Object.hasOwn(properties, key)) errors.push(`${at ? `${at}.` : ''}${key}: tham số không tồn tại (hợp lệ: ${Object.keys(properties).join(', ') || 'không có'})`);
        }
      }
      const output = {};
      for (const [key, sub] of Object.entries(properties)) {
        const path = at ? `${at}.${key}` : key;
        const item = value[key];
        if (item === undefined || (item === null && !required.has(key))) {
          if (required.has(key)) errors.push(`${path}: bắt buộc`);
          continue;
        }
        output[key] = check(sub, item, path, errors, coerce);
      }
      return output;
    }
    case 'array': {
      let list = value;
      if (!Array.isArray(list) && coerce && typeof list === 'string' && schema.items?.type === 'string') list = [list];
      if (!Array.isArray(list)) { errors.push(`${where} phải là mảng`); return value; }
      if (schema.maxItems !== undefined && list.length > schema.maxItems) errors.push(`${where}: tối đa ${schema.maxItems} phần tử (đang ${list.length})`);
      if (schema.minItems !== undefined && list.length < schema.minItems) errors.push(`${where}: cần ít nhất ${schema.minItems} phần tử`);
      return list.map((item, index) => check(schema.items ?? {}, item, `${where}[${index}]`, errors, coerce));
    }
    case 'integer':
    case 'number': {
      let number = value;
      if (coerce && typeof number === 'string' && number.trim() !== '' && Number.isFinite(Number(number))) number = Number(number);
      if (typeof number !== 'number' || !Number.isFinite(number) || (schema.type === 'integer' && !Number.isInteger(number))) {
        errors.push(`${where} phải là ${schema.type === 'integer' ? 'số nguyên' : 'số'}`);
        return value;
      }
      if (schema.minimum !== undefined && number < schema.minimum) errors.push(`${where} phải ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && number > schema.maximum) errors.push(`${where} phải ≤ ${schema.maximum}`);
      return number;
    }
    case 'boolean': {
      let flag = value;
      if (coerce && flag === 'true') flag = true;
      else if (coerce && flag === 'false') flag = false;
      if (typeof flag !== 'boolean') { errors.push(`${where} phải là true hoặc false`); return value; }
      return flag;
    }
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${where} phải là chuỗi`); return value; }
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} phải là một trong: ${schema.enum.join(', ')}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where} dài tối đa ${schema.maxLength} ký tự (đang ${value.length})`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(schema.minLength <= 1 ? `${where} không được rỗng` : `${where} phải dài ít nhất ${schema.minLength} ký tự (đang ${value.length})`);
      return value;
    }
    default:
      return value;
  }
}

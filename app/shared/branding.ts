export const DEFAULT_PRODUCT_NAME = '在线监考客户端';
export const INTERNAL_APP_NAME = 'HydroProctorClient';
// 保留已有默认 macOS 数据目录，更换展示名称不会生成另一套设备身份与日志。
export const MAC_DATA_FOLDER = `${DEFAULT_PRODUCT_NAME}.data`;

export function validateProductName(value: unknown = DEFAULT_PRODUCT_NAME): string {
    if (typeof value !== 'string') throw new Error('productName 必须是完整的软件名称');
    const name = value.trim();
    const hasControlCharacter = [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name.endsWith('监考客户端') || name.length > 60 || hasControlCharacter || /[<>:"/\\|?*\u2028\u2029]/u.test(name)) {
        throw new Error('productName 必须以“监考客户端”结尾，长度不超过 60，且不能包含文件名特殊字符或换行');
    }
    return name;
}

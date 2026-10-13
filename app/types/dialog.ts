/** 只把展示所需字段发送给隔离页面，Electron 对象不能跨 IPC。 */
export interface DialogModel {
    title: string;
    message: string;
    detail?: string;
    type?: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    checkboxLabel?: string;
    checkboxChecked?: boolean;
    /** 主按钮/次要按钮仅决定 React 展示层级，不改变 response 编号和取消语义。 */
    primaryIds?: number[];
    secondaryDetail?: string;
}

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
}

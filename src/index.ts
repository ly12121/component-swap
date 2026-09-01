import extensionConfig from '../extension.json' with { type: 'json' };

const DIALOG_TITLE = '器件交换';
const PICK_LISTENER_ID = 'component-pose-swap-picker';
const SWAP_WINDOW_ID = 'componentPoseSwapWindow';
const SWAP_WINDOW_FILE = '/iframe/index.html';

type ToastType = 'error' | 'warn' | 'info' | 'success' | 'question';

let swapWindowOpen = false;
let windowOpening = false;

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	// 菜单功能按需打开窗口，无需注册系统快捷键。
}

function showError(message: string): void {
	eda.sys_Dialog.showInformationMessage(message, DIALOG_TITLE, '知道了');
}

function showToast(message: string, type: ToastType, seconds = 4): void {
	eda.sys_Message.showToastMessage(message, type as ESYS_ToastMessageType, seconds);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function removeSelectionListener(): void {
	try {
		eda.pcb_Event.removeEventListener(PICK_LISTENER_ID);
	}
	catch (error) {
		console.warn('[器件连续交换] 无法移除画布点选监听。', error);
	}
}

async function clearCanvasSelection(): Promise<void> {
	try {
		await eda.pcb_SelectControl.clearSelected();
	}
	catch (error) {
		console.warn('[器件连续交换] 无法清除当前选中状态。', error);
	}
}

function cleanupPicker(showStoppedMessage: boolean): void {
	removeSelectionListener();
	void clearCanvasSelection();

	if (showStoppedMessage) {
		showToast('连续交换已停止。', 'info', 3);
	}
}

export function deactivate(): void {
	swapWindowOpen = false;
	cleanupPicker(false);
	void eda.sys_IFrame.closeIFrame(SWAP_WINDOW_ID).catch((error: unknown) => {
		console.warn('[器件连续交换] 无法关闭交换窗口。', error);
	});
}

function handleWindowOpenFailure(error: unknown): void {
	// 部分 EDA 版本会在窗口关闭时才结束 openIFrame Promise，此时不重复报错。
	if (!swapWindowOpen) {
		return;
	}

	swapWindowOpen = false;
	cleanupPicker(false);
	showError(getErrorMessage(error));
}

export async function openSwapWindow(): Promise<void> {
	if (windowOpening) {
		return;
	}

	if (swapWindowOpen) {
		try {
			const shown = await eda.sys_IFrame.showIFrame(SWAP_WINDOW_ID);
			if (shown) {
				return;
			}
		}
		catch (error) {
			console.warn('[器件连续交换] 无法恢复交换窗口，将重新打开。', error);
		}

		swapWindowOpen = false;
	}

	windowOpening = true;

	try {
		// 防止异常关闭留下旧监听；窗口脚本加载后会重新注册。
		cleanupPicker(false);
		swapWindowOpen = true;

		const openRequest = eda.sys_IFrame.openIFrame(
			SWAP_WINDOW_FILE,
			540,
			620,
			SWAP_WINDOW_ID,
			{
				title: DIALOG_TITLE,
				grayscaleMask: false,
				minimizeButton: true,
				minimizeStyle: 'constricted',
				onBeforeCloseCallFn: () => {
					swapWindowOpen = false;
					cleanupPicker(true);
					return true;
				},
			},
		);

		void openRequest
			.then((opened) => {
				if (!opened) {
					handleWindowOpenFailure(
						new Error('交换窗口未能打开，请确认扩展已启用后重试。'),
					);
				}
			})
			.catch(handleWindowOpenFailure);
	}
	catch (error) {
		swapWindowOpen = false;
		cleanupPicker(false);
		showError(getErrorMessage(error));
	}
	finally {
		windowOpening = false;
	}
}

export async function stopContinuousSwap(): Promise<void> {
	swapWindowOpen = false;
	cleanupPicker(true);

	try {
		await eda.sys_IFrame.closeIFrame(SWAP_WINDOW_ID);
	}
	catch (error) {
		console.warn('[器件连续交换] 无法关闭交换窗口。', error);
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		[
			`版本：${extensionConfig.version}`,
			'',
			'使用方法：',
			'1. 打开窗口后，依次在 PCB 画布选择器件1和器件2。',
			'2. 两个器件都处于选中状态后会立即交换，不需要再次确认。',
			'3. 只选择了一个器件时，可在窗口中取消对应槽位后重新选择。',
			'4. 每次交换提交成功后会立即清空器件1和器件2列表，随后继续选择下一对即可。',
			'',
			'默认开启“同步交换位号丝印”：',
			'- 同时交换两个器件 Designator 位号文字的 X、Y 坐标和旋转方向。',
			'- 位号文字内容、字体、可见性和所在丝印层保持不变。',
			'- 不需要同步位号时，可在选择第二个器件前取消勾选。',
			'',
			'默认开启“交换对应引脚连接的走线网络”：',
			'- 两器件焊盘编号必须完全一致。',
			'- 扩展从每个器件焊盘中心出发，只查找实际连通的直线、圆弧和过孔。',
			'- 只交换这些连通走线图元的网络；不按网络名扫描全板。',
			'- PCB 网表、两个器件及其它器件的引脚、覆铜、填充、独立焊盘和未连通铜图元均不修改。',
			'- 板面、物料信息及原理图不变。',
			'',
			'关闭网络同步后，仍互换器件及已开启的位号丝印 X、Y 坐标和旋转角度；此时允许不同封装和不同焊盘数量。',
			'锁定器件不会被修改；请先解锁。',
			'交换网络后必须运行 DRC，并建议先保留工程副本。',
			'',
			'本版本不注册任何键盘快捷键。',
		].join('\n'),
		DIALOG_TITLE,
		'知道了',
	);
}

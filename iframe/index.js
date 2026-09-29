/* global eda */

'use strict';

const PICK_LISTENER_ID = 'component-pose-swap-picker';
const SELECTED_EVENT = 'selected';
const CLEAR_SELECTED_EVENT = 'clearSelected';
const COMPONENT_TYPE = 'Component';
const EVENT_SUPPRESSION_MS = 220;
const NETWORK_BATCH_SIZE = 8;
const NETWORK_VERIFY_DELAYS_MS = [0, 40, 80, 120, 180, 260, 380];
const ROUTE_PRIMITIVE_TYPES = new Set(['Line', 'Arc', 'Via']);
const PRIMITIVE_API_BY_TYPE = {
	Line: 'pcb_PrimitiveLine',
	Arc: 'pcb_PrimitiveArc',
	Via: 'pcb_PrimitiveVia',
};

const slotElements = [0, 1].map(index => ({
	card: document.getElementById(`slot-${index + 1}`),
	name: document.getElementById(`component-name-${index + 1}`),
	meta: document.getElementById(`component-meta-${index + 1}`),
	pick: document.getElementById(`pick-${index + 1}`),
	cancel: document.getElementById(`cancel-${index + 1}`),
}));
const feedbackElement = document.getElementById('feedback');
const modeStatusElement = document.getElementById('mode-status');
const clearAllButton = document.getElementById('clear-all');
const designatorSyncCheckbox = document.getElementById('sync-designators');
const networkSyncCheckbox = document.getElementById('sync-networks');
const padPickCheckbox = document.getElementById('pick-via-pads');
const silkPickCheckbox = document.getElementById('pick-via-silkscreen');

let slots = [undefined, undefined];
let activeSlotIndex = 0;
let selectionEpoch = 0;
let swapInProgress = false;
let internalSelectionUpdate = false;
let suppressEventsUntil = 0;
let clearSelectionTimer;
let disposed = false;
let selectionSyncQueue = Promise.resolve();
let pickRequest = 0;
const EXTENSION_VERSION = '2.4.11';
const ERROR_LOG_KEY = 'component-swap-last-error-v1';
const diagnosticEvents = [];
let lastErrorLog = '';
let logSaveQueue = Promise.resolve();

// Compatibility for hosts which accept openIFrame x/y but omit them when
// creating their dialog. Only touch the verified ancestor of our own iframe.
function positionOwnWindow() {
	const frame = window.frameElement;
	const container = frame?.closest('[id^="iframeContainer"]');
	const id = container?.id.slice('iframeContainer'.length);
	if (!id?.includes('componentPoseSwapWindow')) {
		throw new Error('未找到本扩展窗口容器，未修改任何窗口。');
	}
	const host = frame.ownerDocument;
	const box = host.getElementById(`${id}_dialog_box`);
	const root = host.getElementById(id);
	if (!box?.contains(frame) || !root?.contains(box)) {
		throw new Error('窗口结构不匹配，未修改任何窗口。');
	}
	const viewport = host.defaultView;
	const before = box.getBoundingClientRect();
	if (!(before.width > 0 && before.height > 0 && viewport.innerWidth > 0 && viewport.innerHeight > 0)) {
		throw new Error('窗口尺寸尚未就绪。');
	}
	const x = Math.max(0, Math.round(viewport.innerWidth - 328 - before.width));
	const y = Math.max(0, Math.min(136, viewport.innerHeight - before.height));
	box.style.position = 'fixed';
	box.style.left = `${x}px`;
	box.style.top = `${y}px`;
	// Match the host's explicit-position path; remove its outer centering offsets.
	for (const key of ['left', 'top', 'width', 'height']) root.style[key] = '';
	root.style.opacity = '1';
	const after = box.getBoundingClientRect();
	return { x, y, actualX: after.left, actualY: after.top, matched: Math.abs(after.left - x) < 2 && Math.abs(after.top - y) < 2 };
}

async function positionWindowAfterMount() {
	let interacted = false;
	let root;
	const stop = () => {
		interacted = true;
	};
	const displayLog = (message) => {
		const text = document.getElementById('error-log');
		const status = document.getElementById('log-status');
		if (!lastErrorLog && text && status) {
			text.value = JSON.stringify({ extension: '器件交换', version: EXTENSION_VERSION, events: diagnosticEvents }, null, 2);
			status.textContent = message;
		}
	};
	try {
		root = window.frameElement?.closest('[id$="_dialog_box"]');
		root?.addEventListener('pointerdown', stop, true);
		// The inspected host centers at 200 ms. Keep that guard, then verify on
		// the next short tick instead of adding another 400 ms of hidden time.
		// Total intentional wait: 250 ms (previously 750 ms).
		for (const delay of [230, 20]) {
			await new Promise(resolve => setTimeout(resolve, delay));
			if (disposed || interacted)
				return;
			const result = positionOwnWindow();
			recordDiagnostic('window-position-applied', result);
			displayLog(result.matched ? '已生成定位日志，右上角坐标已回读确认。' : '已生成定位日志，坐标未吻合，请复制反馈。');
		}
	}
	catch (error) {
		recordDiagnostic('window-position-failed', { message: String(error) });
		displayLog('自动定位失败，已生成日志，可复制反馈；交换功能仍可使用。');
	}
	finally {
		root?.removeEventListener('pointerdown', stop, true);
		window.__swapReveal?.();
	}
}

function recordDiagnostic(event, data = {}) {
	let snapshot;
	try {
		snapshot = JSON.parse(JSON.stringify(data));
	}
	catch {
		snapshot = { note: '此事件包含无法序列化的属性。' };
	}
	diagnosticEvents.push({ time: new Date().toISOString(), event, data: snapshot });
	if (diagnosticEvents.length > 120) {
		diagnosticEvents.shift();
	}
}

function selectionSummary(items) {
	return (Array.isArray(items) ? items : [items]).filter(Boolean).slice(0, 30).map(item => ({
		primitiveId: item.primitiveId,
		primitiveType: item.primitiveType,
		parentComponentPrimitiveId: item.parentComponentPrimitiveId ?? item.parentPrimitiveId,
		designator: item.designator ?? item.parentComponentDesignator,
	}));
}

function freezeErrorLog(message) {
	lastErrorLog = JSON.stringify({
		extension: '器件交换',
		version: EXTENSION_VERSION,
		time: new Date().toISOString(),
		message,
		candidates: slots,
		activeSlotIndex,
		selectionEpoch,
		swapInProgress,
		internalSelectionUpdate,
		options: { pads: padPickCheckbox.checked, silkscreen: silkPickCheckbox.checked, designators: designatorSyncCheckbox.checked, networks: networkSyncCheckbox.checked },
		events: diagnosticEvents,
	}, null, 2);
	const snapshot = lastErrorLog;
	const text = document.getElementById('error-log');
	if (text) {
		text.value = snapshot;
	}
	const status = document.getElementById('log-status');
	if (status) {
		status.textContent = '已记录最近一次报错，可复制发送。';
	}
	// Keep one bounded snapshot across window closes; never upload it automatically.
	if (typeof eda.sys_Storage?.setExtensionUserConfig === 'function') {
		logSaveQueue = logSaveQueue.catch(() => {}).then(() => eda.sys_Storage.setExtensionUserConfig(ERROR_LOG_KEY, snapshot)).catch(() => {});
	}
}

async function copyErrorLog() {
	const text = document.getElementById('error-log');
	const status = document.getElementById('log-status');
	const panel = document.getElementById('diagnostics');
	if (!lastErrorLog) {
		lastErrorLog = JSON.stringify({ extension: '器件交换', version: EXTENSION_VERSION, candidates: slots, events: diagnosticEvents }, null, 2);
	}
	text.value = lastErrorLog;
	panel.open = true;
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(lastErrorLog);
			status.textContent = '日志已复制，请粘贴发送。';
			return;
		}
	}
	catch { /* Clipboard permission may be unavailable inside the EDA iframe. */ }
	text.focus();
	text.select();
	try {
		if (document.execCommand?.('copy')) {
			status.textContent = '日志已复制，请粘贴发送。';
			return;
		}
	}
	catch { /* Leave the full text selected for manual copy. */ }
	status.textContent = '日志已全选，请按 Ctrl+C 复制。';
}

async function clearErrorLog() {
	diagnosticEvents.length = 0;
	lastErrorLog = '';
	document.getElementById('error-log').value = '';
	const status = document.getElementById('log-status');
	status.textContent = '正在清除日志…';
	// Serialize with pending saves, so an older snapshot cannot reappear after clearing.
	const task = logSaveQueue.catch(() => {}).then(async () => {
		if (typeof eda.sys_Storage?.setExtensionUserConfig === 'function') {
			const result = await eda.sys_Storage.setExtensionUserConfig(ERROR_LOG_KEY, '');
			if (result === false)
				throw new Error('Storage write rejected');
		}
	});
	logSaveQueue = task.catch(() => {});
	try {
		await task;
		if (!lastErrorLog)
			status.textContent = '日志已清除。后续报错将重新记录。';
	}
	catch {
		if (!lastErrorLog)
			status.textContent = '当前日志已清除，但清除本地保存记录失败，请重试。';
	}
}

function getErrorMessage(error) {
	recordDiagnostic('exception', { message: String(error?.message ?? error).slice(0, 1200), stack: String(error?.stack ?? '').slice(0, 2000) });
	return error instanceof Error ? error.message : String(error);
}

function setFeedback(message, type = 'info') {
	recordDiagnostic('feedback', { type, message });
	if (type === 'error') {
		freezeErrorLog(message);
	}
	feedbackElement.textContent = message;
	feedbackElement.className = type === 'info' ? 'feedback' : `feedback ${type}`;
}

function render() {
	for (let index = 0; index < slotElements.length; index += 1) {
		const elements = slotElements[index];
		const component = slots[index];
		const isActive = activeSlotIndex === index && !swapInProgress;

		elements.card.classList.toggle('active', isActive);
		elements.name.textContent = component?.label ?? '未选择';
		elements.meta.textContent = component
			? `图元 ID：${component.primitiveId}`
			: (isActive ? '请在 PCB 画布点击一个器件' : '等待选择');
		elements.pick.textContent = component
			? `重新选取器件${index + 1}`
			: `选取器件${index + 1}`;
		elements.pick.disabled = swapInProgress;
		elements.cancel.disabled = swapInProgress || !component;
	}

	clearAllButton.disabled = swapInProgress || !slots.some(Boolean);
	designatorSyncCheckbox.disabled = swapInProgress;
	networkSyncCheckbox.disabled = swapInProgress;
	padPickCheckbox.disabled = swapInProgress;
	silkPickCheckbox.disabled = swapInProgress;
	modeStatusElement.textContent = swapInProgress ? '正在交换' : '连续交换已启动';
}

function resetCandidateSlots() {
	selectionEpoch += 1;
	slots = [undefined, undefined];
	activeSlotIndex = 0;
	if (clearSelectionTimer) {
		clearTimeout(clearSelectionTimer);
		clearSelectionTimer = undefined;
	}
	render();
}

function getComponentHits(props) {
	const hits = new Map();

	for (const prop of props ?? []) {
		if (prop.primitiveType !== COMPONENT_TYPE) {
			const isPad = ['Pad', 'ComponentPad'].includes(prop.primitiveType);
			const isText = ['Attribute', 'String', 'Text', 'ComponentAttribute'].includes(prop.primitiveType)
				|| ([3, 4].includes(prop.layer) && ['Line', 'Arc', 'Polyline', 'Fill', 'Region'].includes(prop.primitiveType));
			if (!(isPad && padPickCheckbox.checked) && !(isText && silkPickCheckbox.checked)) {
				continue;
			}
		}
		const primitiveId = prop.primitiveType === COMPONENT_TYPE
			? prop.primitiveId
			: prop.parentComponentPrimitiveId ?? prop.parentPrimitiveId;
		const label = prop.primitiveType === COMPONENT_TYPE
			? prop.designator
			: prop.parentComponentDesignator;

		if (!primitiveId) {
			continue;
		}

		if (!hits.has(primitiveId)) {
			hits.set(primitiveId, { primitiveId, label, sourcePrimitiveIds: [], sourceKind: prop.primitiveType });
		}
		const hit = hits.get(primitiveId);
		if (prop.primitiveId && !hit.sourcePrimitiveIds.includes(prop.primitiveId)) {
			hit.sourcePrimitiveIds.push(prop.primitiveId);
		}
	}

	return [...hits.values()];
}

function matchesChildId(selectedIds, child, parentId) {
	const id = child.getState_PrimitiveId?.() ?? child.primitiveId;
	return id && (selectedIds.has(id) || selectedIds.has(`${parentId}${id}`));
}

async function resolvePadHits(rows) {
	const ids = new Set(rows.map(row => row.primitiveId).filter(Boolean));
	if (!padPickCheckbox.checked || !ids.size)
		return [];
	const inspect = async (component) => {
		if (!component)
			return [];
		const parentId = component.getState_PrimitiveId();
		const pads = typeof component.getAllPins === 'function' ? await component.getAllPins() : component.getState_Pads?.() ?? [];
		const sources = [...ids].filter(id => pads.some(pad => matchesChildId(new Set([id]), pad, parentId)));
		return sources.length ? [{ primitiveId: parentId, sourcePrimitiveIds: sources, sourceKind: 'Pad' }] : [];
	};
	// Composite IDs are only a lookup hint. Membership must be verified by the
	// component's actual pad list; never associate an independent pad by proximity.
	const checked = new Set();
	for (const id of ids) {
		const match = id.match(/^([a-f\d]{16}|[a-f\d]{32})e\d+$/i);
		if (!match)
			continue;
		try {
			const component = await eda.pcb_PrimitiveComponent.get(match[1]);
			const hits = await inspect(component);
			checked.add(match[1]);
			if (hits.length)
				return hits;
		}
		catch { /* Other host versions may use a different ID format. */ }
	}
	const components = typeof eda.pcb_PrimitiveComponent.getAll === 'function' ? await eda.pcb_PrimitiveComponent.getAll() : [];
	for (let start = 0; start < components.length; start += 8) {
		const batch = components.slice(start, start + 8).filter(component => !checked.has(component.getState_PrimitiveId()));
		const hits = (await Promise.all(batch.map(inspect))).flat();
		if (hits.length)
			return hits;
	}
	return [];
}

async function resolveComponentHits(props) {
	const rows = Array.isArray(props) ? props : (props ? [props] : []);
	const direct = getComponentHits(rows);
	if (direct.length) {
		return direct;
	}
	if (rows.length && rows.every(row => ['Pad', 'ComponentPad'].includes(row.primitiveType))) {
		return resolvePadHits(rows);
	}
	// Mouse events can omit parent IDs; query the actual selected objects instead.
	const selectedIds = new Set(rows.length ? rows.map(row => row.primitiveId).filter(Boolean) : await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId());
	const normalized = [];
	const addObject = (item) => {
		if (!item) {
			return;
		}
		if (!selectedIds.has(item.getState_PrimitiveId?.() ?? item.primitiveId))
			return;
		normalized.push({
			primitiveId: item.getState_PrimitiveId?.() ?? item.primitiveId,
			primitiveType: item.getState_PrimitiveType?.() ?? item.primitiveType,
			parentComponentPrimitiveId: item.getState_ParentComponentPrimitiveId?.()
				?? item.getState_ParentPrimitiveId?.() ?? item.parentComponentPrimitiveId ?? item.parentPrimitiveId,
			layer: item.getState_Layer?.() ?? item.layer,
		});
	};
	if (!rows.length && typeof eda.pcb_SelectControl.getAllSelectedPrimitives === 'function') {
		for (const item of await eda.pcb_SelectControl.getAllSelectedPrimitives()) {
			addObject(item);
		}
	}
	for (const id of selectedIds) {
		if (!rows.some(row => row.primitiveId === id && ['Text', 'Attribute', 'String'].includes(row.primitiveType)) && typeof eda.pcb_Primitive?.getPrimitiveByPrimitiveId === 'function') {
			try {
				addObject(await eda.pcb_Primitive.getPrimitiveByPrimitiveId(id));
			}
			catch { /* Older hosts do not expose all footprint children through the generic API. */ }
		}
		if (silkPickCheckbox.checked && typeof eda.pcb_PrimitiveAttribute?.get === 'function') {
			try {
				const attr = await eda.pcb_PrimitiveAttribute.get(id);
				if (attr?.getState_ParentPrimitiveId) {
					normalized.push({ primitiveId: id, primitiveType: 'Attribute', parentComponentPrimitiveId: attr.getState_ParentPrimitiveId() });
				}
			}
			catch { /* This selected ID may be a pad rather than an attribute. */ }
		}
	}
	let hits = getComponentHits(normalized);
	if (hits.length) {
		return hits;
	}
	// Last resort: exact child ID lookup, never proximity or designator-text guessing.
	if (selectedIds.size && typeof eda.pcb_PrimitiveComponent.getAll === 'function') {
		for (const component of await eda.pcb_PrimitiveComponent.getAll()) {
			const parentId = component.getState_PrimitiveId();
			if (selectedIds.has(parentId)) {
				normalized.push({ primitiveId: parentId, primitiveType: COMPONENT_TYPE });
			}
			if (padPickCheckbox.checked) {
				const pads = typeof component.getAllPins === 'function' ? await component.getAllPins() : component.getState_Pads?.() ?? [];
				for (const pad of pads) {
					const id = pad.getState_PrimitiveId?.() ?? pad.primitiveId;
					if (selectedIds.has(id)) {
						normalized.push({ primitiveId: id, primitiveType: 'Pad', parentComponentPrimitiveId: parentId });
					}
				}
			}
			if (silkPickCheckbox.checked && eda.pcb_PrimitiveAttribute) {
				for (const attr of await getComponentAttributes(parentId)) {
					const id = attr.getState_PrimitiveId();
					if (selectedIds.has(id)) {
						normalized.push({ primitiveId: id, primitiveType: 'Attribute', parentComponentPrimitiveId: parentId });
					}
				}
			}
		}
		hits = getComponentHits(normalized);
	}
	return hits;
}

function getComponentLabel(component, fallback) {
	return component.getState_Designator()
		?? component.getState_Name()
		?? fallback
		?? component.getState_PrimitiveId();
}

function getPose(component) {
	return {
		x: component.getState_X(),
		y: component.getState_Y(),
		rotation: component.getState_Rotation(),
		layer: component.getState_Layer?.(),
	};
}

async function applyPose(component, pose) {
	const editable = component.toAsync();
	if (pose.layer !== undefined) {
		editable.setState_Layer(pose.layer);
	}
	editable.setState_X(pose.x);
	editable.setState_Y(pose.y);
	editable.setState_Rotation(pose.rotation);
	await editable.done();
}

async function restorePose(primitiveId, pose) {
	const component = await eda.pcb_PrimitiveComponent.get(primitiveId);
	if (!component) {
		throw new Error(`无法重新读取器件 ${primitiveId}`);
	}

	await applyPose(component, pose);
}

function getAttributePose(attribute) {
	const x = attribute.getState_X();
	const y = attribute.getState_Y();
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new TypeError('位号丝印没有可用的 X/Y 坐标。');
	}

	return {
		x,
		y,
		rotation: attribute.getState_Rotation(),
		layer: attribute.getState_Layer?.(),
		mirror: attribute.getState_Mirror?.(),
	};
}

async function getComponentAttributes(componentId) {
	const api = eda.pcb_PrimitiveAttribute;
	if (!api) {
		throw new TypeError('当前 EDA 版本没有提供 PCB 位号属性接口。');
	}

	if (typeof api.getAll === 'function') {
		try {
			const attributes = await api.getAll(componentId);
			if (Array.isArray(attributes)) {
				return attributes;
			}
		}
		catch (error) {
			console.warn('[器件连续交换] getAll 读取位号失败，尝试按图元 ID 读取。', error);
		}
	}

	if (typeof api.getAllPrimitiveId !== 'function' || typeof api.get !== 'function') {
		throw new TypeError('当前 EDA 版本无法读取器件的位号属性。');
	}
	const attributeIds = await api.getAllPrimitiveId(componentId);
	if (!Array.isArray(attributeIds) || attributeIds.length === 0) {
		return [];
	}
	const attributes = await api.get(attributeIds);
	return Array.isArray(attributes) ? attributes : [];
}

async function getComponentDesignatorAttribute(component, label) {
	const componentId = component.getState_PrimitiveId();
	const attributes = await getComponentAttributes(componentId);
	const designators = attributes.filter(attribute => (
		typeof attribute?.getState_Key === 'function'
		&& String(attribute.getState_Key()).toLowerCase() === 'designator'
	));
	if (designators.length === 0) {
		throw new Error(
			`${label} 没有可读取的 Designator 位号属性；请先在 PCB 中显示位号，`
			+ '或取消勾选“同步交换位号丝印”。',
		);
	}

	const attribute = designators.find(item => (
		typeof item.getState_Value === 'function' && item.getState_Value() === label
	)) ?? designators[0];
	if (typeof attribute.getState_PrimitiveLock === 'function'
		&& attribute.getState_PrimitiveLock()) {
		throw new Error(`${label} 的位号丝印已锁定，请先解锁再交换。`);
	}

	return attribute;
}

async function prepareDesignatorSwap(componentA, componentB, labelA, labelB) {
	const [attributeA, attributeB] = await Promise.all([
		getComponentDesignatorAttribute(componentA, labelA),
		getComponentDesignatorAttribute(componentB, labelB),
	]);
	const poseA = getAttributePose(attributeA);
	const poseB = getAttributePose(attributeB);

	return [
		{
			primitiveId: attributeA.getState_PrimitiveId(),
			sourcePose: poseA,
			targetPose: poseB,
		},
		{
			primitiveId: attributeB.getState_PrimitiveId(),
			sourcePose: poseB,
			targetPose: poseA,
		},
	];
}

async function setDesignatorPose(snapshot, pose) {
	const api = eda.pcb_PrimitiveAttribute;
	const attribute = await api.get(snapshot.primitiveId);
	if (!attribute) {
		throw new Error(`无法重新读取位号丝印图元 ${snapshot.primitiveId}。`);
	}

	const editable = attribute.toAsync();
	if (pose.layer !== undefined) {
		editable.setState_Layer(pose.layer);
	}
	if (pose.mirror !== undefined) {
		editable.setState_Mirror(pose.mirror);
	}
	editable.setState_X(pose.x);
	editable.setState_Y(pose.y);
	editable.setState_Rotation(pose.rotation);
	await editable.done();
}

async function applyDesignatorSwap(plan) {
	if (!plan) {
		return;
	}
	await runInBatches(
		plan,
		snapshot => setDesignatorPose(snapshot, snapshot.targetPose),
	);
}

async function restoreDesignatorSwap(plan) {
	if (!plan) {
		return [];
	}
	return runAllInBatches(
		plan,
		snapshot => setDesignatorPose(snapshot, snapshot.sourcePose),
	);
}

function getPadNumber(pad) {
	const value = typeof pad.getState_PadNumber === 'function'
		? pad.getState_PadNumber()
		: pad.padNumber;
	return value === undefined || value === null ? '' : String(value).trim();
}

function getPadNet(pad) {
	const value = typeof pad.getState_Net === 'function'
		? pad.getState_Net()
		: pad.net;
	return value === undefined || value === null ? '' : String(value);
}

async function getComponentPadGroups(component, label) {
	let pads = typeof component.getAllPins === 'function'
		? await component.getAllPins()
		: undefined;

	if ((!Array.isArray(pads) || pads.length === 0)
		&& typeof eda.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId === 'function') {
		pads = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(
			component.getState_PrimitiveId(),
		);
	}

	if (!Array.isArray(pads) || pads.length === 0) {
		throw new Error(`无法读取 ${label} 的器件焊盘，已停止交换。`);
	}

	const groups = new Map();
	for (const pad of pads) {
		const padNumber = getPadNumber(pad);
		if (!padNumber) {
			throw new Error(`${label} 存在空焊盘编号，不能安全交换走线网络。`);
		}

		const net = getPadNet(pad);
		const existing = groups.get(padNumber);
		if (existing && existing.net !== net) {
			throw new Error(`${label} 的焊盘 ${padNumber} 对应多个网络，不能安全交换。`);
		}

		if (existing) {
			existing.pads.push(pad);
		}
		else {
			groups.set(padNumber, { net, pads: [pad] });
		}
	}

	return groups;
}

function assertMatchingPadNumbers(groupsA, groupsB, labelA, labelB) {
	const numbersA = [...groupsA.keys()].sort();
	const numbersB = [...groupsB.keys()].sort();
	if (
		numbersA.length !== numbersB.length
		|| numbersA.some((number, index) => number !== numbersB[index])
	) {
		throw new Error(
			`走线网络同步要求焊盘编号完全一致；${labelA} 为 [${numbersA.join(', ')}]，`
			+ `${labelB} 为 [${numbersB.join(', ')}]。请取消其中一个器件，或关闭“交换引脚连接的走线网络”后重试。`,
		);
	}

	return numbersA;
}

function normalizePrimitiveType(value) {
	const normalized = String(value ?? '').toLowerCase();
	const aliases = {
		line: 'Line',
		track: 'Line',
		arc: 'Arc',
		via: 'Via',
	};
	return aliases[normalized];
}

function getPrimitiveType(primitive) {
	const value = typeof primitive?.getState_PrimitiveType === 'function'
		? primitive.getState_PrimitiveType()
		: (primitive?.pcbItemPrimitiveType ?? primitive?.primitiveType ?? primitive?.type);
	return normalizePrimitiveType(value);
}

function getPrimitiveId(primitive) {
	if (typeof primitive?.getState_PrimitiveId === 'function') {
		return primitive.getState_PrimitiveId();
	}
	return primitive?.primitiveId ?? primitive?.id;
}

async function resolveRoutePrimitive(primitive, expectedType) {
	if (
		typeof primitive?.getState_PrimitiveId === 'function'
		&& typeof primitive?.getAdjacentPrimitives === 'function'
	) {
		return primitive;
	}

	const type = expectedType ?? getPrimitiveType(primitive);
	const primitiveId = getPrimitiveId(primitive);
	const apiName = PRIMITIVE_API_BY_TYPE[type];
	const api = apiName ? eda[apiName] : undefined;
	if (!primitiveId || !api || typeof api.get !== 'function') {
		throw new Error(`无法读取 ${type ?? '未知类型'} 走线图元，已停止交换。`);
	}

	const resolved = await api.get(primitiveId);
	if (!resolved) {
		throw new Error(`无法重新读取走线图元 ${primitiveId}，已停止交换。`);
	}
	return resolved;
}

async function runInBatches(items, task, batchSize = NETWORK_BATCH_SIZE) {
	for (let start = 0; start < items.length; start += batchSize) {
		const batch = items.slice(start, start + batchSize);
		const results = await Promise.allSettled(batch.map(task));
		const failed = results.find(result => result.status === 'rejected');
		if (failed) {
			throw failed.reason;
		}
	}
}

async function runAllInBatches(items, task, batchSize = NETWORK_BATCH_SIZE) {
	const errors = [];
	for (let start = 0; start < items.length; start += batchSize) {
		const batch = items.slice(start, start + batchSize);
		const results = await Promise.allSettled(batch.map(task));
		for (const result of results) {
			if (result.status === 'rejected') {
				errors.push(result.reason);
			}
		}
	}
	return errors;
}

async function mapInBatches(items, task, batchSize = NETWORK_BATCH_SIZE) {
	const values = [];
	for (let start = 0; start < items.length; start += batchSize) {
		const batch = items.slice(start, start + batchSize);
		values.push(...await Promise.all(batch.map(task)));
	}
	return values;
}

async function collectPadConnectedRoute(
	pads,
	sourceNet,
	targetNet,
	padNumber,
	label,
	snapshotsById,
) {
	const queue = [];
	for (const pad of pads) {
		if (typeof pad?.getConnectedPrimitives !== 'function') {
			throw new TypeError(`当前 EDA 版本无法读取 ${label} 焊盘 ${padNumber} 的连接走线。`);
		}
		const connected = await pad.getConnectedPrimitives(true);
		queue.push(...(connected ?? []));
	}

	const visited = new Set();
	while (queue.length > 0) {
		const rawPrimitive = queue.shift();
		const type = getPrimitiveType(rawPrimitive);
		if (!type || !ROUTE_PRIMITIVE_TYPES.has(type)) {
			throw new Error(`${label} 焊盘 ${padNumber} 连接了无法安全处理的走线图元。`);
		}

		const primitive = await resolveRoutePrimitive(rawPrimitive, type);
		const primitiveId = getPrimitiveId(primitive);
		if (!primitiveId) {
			throw new Error(`${label} 焊盘 ${padNumber} 的连接走线缺少图元 ID。`);
		}
		if (visited.has(primitiveId)) {
			continue;
		}
		visited.add(primitiveId);

		if (typeof primitive.getState_PrimitiveLock === 'function'
			&& primitive.getState_PrimitiveLock()) {
			throw new Error(`${label} 焊盘 ${padNumber} 的连接走线包含已锁定的 ${type} 图元。`);
		}

		const currentNet = getPadNet(primitive);
		if (currentNet !== sourceNet) {
			throw new Error(
				`${label} 焊盘 ${padNumber} 的网络是 ${sourceNet || '（无网络）'}，`
				+ `但其连接走线 ${primitiveId} 的网络是 ${currentNet || '（无网络）'}；请先修复现有网络不一致。`,
			);
		}

		const existing = snapshotsById.get(primitiveId);
		if (existing && existing.targetNet !== targetNet) {
			throw new Error(
				`走线图元 ${primitiveId} 同时连接到多个需要交换为不同网络的引脚，已停止交换。`,
			);
		}
		if (!existing) {
			snapshotsById.set(primitiveId, {
				primitiveId,
				type,
				sourceNet: currentNet,
				targetNet,
			});
		}

		if (typeof primitive.getAdjacentPrimitives !== 'function') {
			throw new TypeError(`当前 EDA 版本无法继续读取走线图元 ${primitiveId} 的相邻连接。`);
		}
		const adjacent = await primitive.getAdjacentPrimitives();
		for (const item of adjacent ?? []) {
			const adjacentType = getPrimitiveType(item);
			if (adjacentType && ROUTE_PRIMITIVE_TYPES.has(adjacentType)) {
				queue.push(item);
			}
		}
	}
}

function getRoutePrimitiveApi(snapshot) {
	const apiName = PRIMITIVE_API_BY_TYPE[snapshot.type];
	const api = eda[apiName];
	if (!api || typeof api.get !== 'function') {
		throw new TypeError(`当前 EDA 版本无法读取 ${snapshot.type} 走线图元。`);
	}
	return api;
}

async function readRoutePrimitiveNetwork(snapshot) {
	const primitive = await getRoutePrimitiveApi(snapshot).get(snapshot.primitiveId);
	if (!primitive || typeof primitive.getState_Net !== 'function') {
		throw new Error(`无法读取 ${snapshot.type} 图元 ${snapshot.primitiveId}。`);
	}
	return {
		currentNet: getPadNet(primitive),
		primitive,
	};
}

async function commitRoutePrimitiveNetwork(snapshot, net, expectedNet, force = false) {
	let { currentNet, primitive } = await readRoutePrimitiveNetwork(snapshot);

	if (currentNet === net && !force) {
		return;
	}
	if (currentNet !== expectedNet && currentNet !== net) {
		throw new Error(
			`走线图元 ${snapshot.primitiveId} 的网络已从 ${expectedNet || '（无网络）'} 变为 `
			+ `${currentNet || '（无网络）'}，为避免覆盖其它修改，本次操作已停止。`,
		);
	}

	primitive = primitive.toAsync();
	primitive.setState_Net(net);
	await primitive.done();
}

async function verifyRoutePrimitiveNetworks(snapshots, desiredNetOf, previousNetOf) {
	let pending = [...snapshots];
	let elapsedMs = 0;
	const lastObservations = new Map();

	for (const delayMs of NETWORK_VERIFY_DELAYS_MS) {
		if (delayMs > 0) {
			await new Promise(resolve => setTimeout(resolve, delayMs));
			elapsedMs += delayMs;
		}

		const observations = await mapInBatches(pending, async (snapshot) => {
			try {
				const { currentNet } = await readRoutePrimitiveNetwork(snapshot);
				return { currentNet, snapshot };
			}
			catch (error) {
				return { error, snapshot };
			}
		});

		pending = [];
		for (const observation of observations) {
			const { snapshot } = observation;
			lastObservations.set(snapshot.primitiveId, observation);
			if (observation.error) {
				pending.push(snapshot);
				continue;
			}

			const desiredNet = desiredNetOf(snapshot);
			if (observation.currentNet === desiredNet) {
				continue;
			}
			const previousNet = previousNetOf(snapshot);
			if (observation.currentNet !== previousNet) {
				throw new Error(
					`走线图元 ${snapshot.primitiveId} 的网络在提交期间变为 `
					+ `${observation.currentNet || '（无网络）'}，为避免覆盖其它修改，本次操作已停止。`,
				);
			}
			pending.push(snapshot);
		}

		if (pending.length === 0) {
			return;
		}
	}

	const firstPending = pending[0];
	const lastObservation = lastObservations.get(firstPending.primitiveId);
	if (lastObservation?.error) {
		throw new Error(
			`走线图元 ${firstPending.primitiveId} 提交后连续 ${elapsedMs} ms 无法重新读取：${getErrorMessage(lastObservation.error)}`,
		);
	}
	throw new Error(
		`走线图元 ${firstPending.primitiveId} 提交并刷新后等待 ${elapsedMs} ms，网络仍为 `
		+ `${lastObservation?.currentNet || '（无网络）'}，目标网络是 `
		+ `${desiredNetOf(firstPending) || '（无网络）'}；本次交换已停止。`,
	);
}

async function refreshPcbCalculations() {
	try {
		if (typeof eda.pcb_Document?.triggerCanvasUpdateCalculation === 'function') {
			await eda.pcb_Document.triggerCanvasUpdateCalculation();
			return;
		}
		if (typeof eda.pcb_Document?.startCalculatingRatline === 'function') {
			await eda.pcb_Document.startCalculatingRatline();
		}
	}
	catch (error) {
		console.warn('[器件连续交换] 画布/飞线刷新失败。', error);
	}
}

async function prepareConnectedRouteSwap(componentA, componentB, labelA, labelB) {
	const [groupsA, groupsB] = await Promise.all([
		getComponentPadGroups(componentA, labelA),
		getComponentPadGroups(componentB, labelB),
	]);
	const padNumbers = assertMatchingPadNumbers(groupsA, groupsB, labelA, labelB);
	const snapshotsById = new Map();
	let pairCount = 0;

	for (const padNumber of padNumbers) {
		const groupA = groupsA.get(padNumber);
		const groupB = groupsB.get(padNumber);
		if (groupA.net === groupB.net) {
			continue;
		}

		pairCount += 1;
		await collectPadConnectedRoute(
			groupA.pads,
			groupA.net,
			groupB.net,
			padNumber,
			labelA,
			snapshotsById,
		);
		await collectPadConnectedRoute(
			groupB.pads,
			groupB.net,
			groupA.net,
			padNumber,
			labelB,
			snapshotsById,
		);
	}

	return {
		pairCount,
		routeSnapshots: [...snapshotsById.values()],
	};
}

async function applyConnectedRouteSwap(plan) {
	if (plan.routeSnapshots.length === 0) {
		return;
	}

	await runInBatches(
		plan.routeSnapshots,
		snapshot => commitRoutePrimitiveNetwork(snapshot, snapshot.targetNet, snapshot.sourceNet),
	);
	await refreshPcbCalculations();
	await verifyRoutePrimitiveNetworks(
		plan.routeSnapshots,
		snapshot => snapshot.targetNet,
		snapshot => snapshot.sourceNet,
	);
}

async function restoreConnectedRouteSwap(plan) {
	const errors = [];
	if (!plan || plan.routeSnapshots.length === 0) {
		return errors;
	}

	const writeErrors = await runAllInBatches(
		plan.routeSnapshots,
		snapshot => commitRoutePrimitiveNetwork(
			snapshot,
			snapshot.sourceNet,
			snapshot.targetNet,
			true,
		),
	);
	await refreshPcbCalculations();

	try {
		await verifyRoutePrimitiveNetworks(
			plan.routeSnapshots,
			snapshot => snapshot.sourceNet,
			snapshot => snapshot.targetNet,
		);
	}
	catch (error) {
		errors.push(...writeErrors, error);
	}

	return errors;
}

function syncCanvasSelection() {
	// Serialize clear/select pairs so two overlapping callbacks cannot clear a newer pair.
	selectionSyncQueue = selectionSyncQueue.catch(() => {}).then(syncCanvasSelectionNow);
	return selectionSyncQueue;
}

async function syncCanvasSelectionNow() {
	const epoch = selectionEpoch;
	// Let the mouse click's trailing host selection update complete first.
	if (slots.some(Boolean))
		await new Promise(resolve => setTimeout(resolve, 100));
	if (disposed || epoch !== selectionEpoch)
		return;
	const primitiveIds = slots.filter(Boolean).map(component => component.primitiveId);
	const candidates = slots.filter(Boolean);
	if (primitiveIds.length) {
		const current = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		const allowed = new Set(candidates.flatMap(item => [item.primitiveId, ...(item.sourcePrimitiveIds ?? [])]));
		if (!current.length || current.some(id => !allowed.has(id))) {
			const normalized = await getSelectedComponentIds(candidates);
			if (!candidates.some(item => normalized.has(item.primitiveId)))
				return;
		}
	}
	recordDiagnostic('selection-sync-start', { requested: primitiveIds, epoch: selectionEpoch });
	internalSelectionUpdate = true;
	suppressEventsUntil = Date.now() + EVENT_SUPPRESSION_MS;

	try {
		await eda.pcb_SelectControl.clearSelected();
		if (primitiveIds.length > 0) {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				internalSelectionUpdate = true;
				const accepted = await eda.pcb_SelectControl.doSelectPrimitives(primitiveIds);
				internalSelectionUpdate = false;
				suppressEventsUntil = Date.now() + EVENT_SUPPRESSION_MS;
				recordDiagnostic('selection-write-result', { attempt, accepted, requested: primitiveIds });
				if (accepted === false)
					throw new Error('PCB 未接受器件选中请求，请重新选择。');
				await new Promise(resolve => setTimeout(resolve, 100));
				if (disposed || epoch !== selectionEpoch)
					return;
				if (JSON.stringify(slots.filter(Boolean).map(item => item.primitiveId)) !== JSON.stringify(primitiveIds))
					return;
				const actual = await getSelectedComponentIds(candidates);
				if (primitiveIds.every(id => actual.has(id)))
					break;
				// Only repair a nonempty subset of this same pair. Empty or unrelated
				// selection means the user cleared/changed selection; never resurrect it.
				const raw = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
				const allowed = new Set(slots.filter(Boolean).flatMap(item => [item.primitiveId, ...(item.sourcePrimitiveIds ?? [])]));
				if (!raw.length || raw.some(id => !allowed.has(id)))
					break;
			}
		}
	}
	finally {
		recordDiagnostic('selection-sync-end', { requested: primitiveIds, epoch: selectionEpoch });
		internalSelectionUpdate = false;
		suppressEventsUntil = Date.now() + EVENT_SUPPRESSION_MS;
	}
}

async function getSelectedComponentIds(candidates) {
	const selectedIds = new Set(await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId());
	recordDiagnostic('selection-read', { selectedCount: selectedIds.size, selected: [...selectedIds].slice(0, 60), candidates });
	const result = new Set(selectedIds);
	for (const candidate of candidates.filter(Boolean)) {
		if (result.has(candidate.primitiveId)) {
			continue;
		}
		// The source IDs were supplied by EDA with this component's parent ID.
		if ((candidate.sourcePrimitiveIds ?? []).some(id => selectedIds.has(id))) {
			result.add(candidate.primitiveId);
			continue;
		}
		// Some hosts expand a selected component into pad/attribute IDs on readback.
		const component = await eda.pcb_PrimitiveComponent.get(candidate.primitiveId);
		if (!component) {
			continue;
		}
		const pads = typeof component.getAllPins === 'function'
			? await component.getAllPins()
			: component.getState_Pads?.() ?? [];
		const childId = item => item.getState_PrimitiveId?.() ?? item.primitiveId;
		if (pads.some(pad => matchesChildId(selectedIds, pad, candidate.primitiveId))) {
			result.add(candidate.primitiveId);
			continue;
		}
		if (eda.pcb_PrimitiveAttribute) {
			const attributes = await getComponentAttributes(candidate.primitiveId);
			if (attributes.some(attribute => selectedIds.has(childId(attribute)))) {
				result.add(candidate.primitiveId);
			}
		}
	}
	recordDiagnostic('selection-normalized', { selected: [...result].slice(0, 60) });
	return result;
}

async function waitForSelectedComponents(candidates) {
	let selectedIds;
	for (const delay of [0, 40, 80, 140]) {
		if (delay) {
			await new Promise(resolve => setTimeout(resolve, delay));
		}
		selectedIds = await getSelectedComponentIds(candidates);
		recordDiagnostic('selection-verify', { delay, matched: candidates.map(item => ({ id: item.primitiveId, selected: selectedIds.has(item.primitiveId) })) });
		if (candidates.every(candidate => selectedIds.has(candidate.primitiveId))) {
			break;
		}
	}
	return selectedIds;
}

function chooseNextActiveSlot() {
	if (!slots[0]) {
		activeSlotIndex = 0;
	}
	else if (!slots[1]) {
		activeSlotIndex = 1;
	}
	else {
		activeSlotIndex = undefined;
	}
}

async function cancelSlot(index, showMessage = true) {
	if (swapInProgress) {
		return;
	}

	selectionEpoch += 1;
	const cancelled = slots[index];
	slots[index] = undefined;
	activeSlotIndex = index;
	render();
	await syncCanvasSelection();

	if (showMessage) {
		setFeedback(
			cancelled
				? `已取消器件${index + 1} ${cancelled.label}，请重新选择。`
				: `请在 PCB 画布选择器件${index + 1}。`,
			'warn',
		);
	}
}

async function cancelAll(showMessage = true) {
	if (swapInProgress) {
		return;
	}

	resetCandidateSlots();
	await syncCanvasSelection();

	if (showMessage) {
		setFeedback('已取消全部选中器件，请重新选择器件1。', 'warn');
	}
}

async function reconcileSelectedState() {
	if (disposed || internalSelectionUpdate || Date.now() < suppressEventsUntil || swapInProgress) {
		return;
	}

	try {
		const epoch = selectionEpoch;
		const selectedIds = await getSelectedComponentIds(slots);
		if (epoch !== selectionEpoch || internalSelectionUpdate || swapInProgress) {
			return;
		}
		let changed = false;

		for (let index = 0; index < slots.length; index += 1) {
			if (slots[index] && !selectedIds.has(slots[index].primitiveId)) {
				slots[index] = undefined;
				changed = true;
			}
		}

		if (changed) {
			chooseNextActiveSlot();
			render();
			setFeedback('已根据 PCB 当前选中状态取消对应器件。', 'warn');
		}
	}
	catch (error) {
		setFeedback(`无法读取 PCB 选中状态：${getErrorMessage(error)}`, 'error');
	}
}

async function swapSelectedComponents() {
	if (swapInProgress || !slots[0] || !slots[1]) {
		return;
	}

	const componentHitA = slots[0];
	const componentHitB = slots[1];
	const synchronizeDesignators = Boolean(designatorSyncCheckbox.checked);
	const synchronizeNetworks = Boolean(networkSyncCheckbox.checked);
	let swapCommitted = false;
	selectionEpoch += 1;
	swapInProgress = true;
	render();
	setFeedback(
		synchronizeNetworks
			? `正在检查 ${componentHitA.label} 与 ${componentHitB.label} 引脚实际连接的走线...`
			: `正在检查 ${componentHitA.label} 与 ${componentHitB.label} 的器件及位号丝印...`,
	);

	try {
		const selectedIds = await waitForSelectedComponents([componentHitA, componentHitB]);
		if (!selectedIds.has(componentHitA.primitiveId) || !selectedIds.has(componentHitB.primitiveId)) {
			throw new Error('器件1或器件2已不在 PCB 选中状态，本次没有执行交换。');
		}

		const [componentA, componentB] = await Promise.all([
			eda.pcb_PrimitiveComponent.get(componentHitA.primitiveId),
			eda.pcb_PrimitiveComponent.get(componentHitB.primitiveId),
		]);

		if (!componentA || !componentB) {
			throw new Error('无法读取选中的器件，请重新选择这一对器件。');
		}

		const labelA = getComponentLabel(componentA, componentHitA.label);
		const labelB = getComponentLabel(componentB, componentHitB.label);
		if (componentA.getState_PrimitiveLock() || componentB.getState_PrimitiveLock()) {
			throw new Error(`器件 ${labelA} 或 ${labelB} 已锁定，请先解锁再交换。`);
		}

		const poseA = getPose(componentA);
		const poseB = getPose(componentB);
		const [designatorPlan, networkPlan] = await Promise.all([
			synchronizeDesignators
				? prepareDesignatorSwap(componentA, componentB, labelA, labelB)
				: undefined,
			synchronizeNetworks
				? prepareConnectedRouteSwap(componentA, componentB, labelA, labelB)
				: undefined,
		]);
		const pendingDetails = ['位置', '方向', '所在板层'];
		if (designatorPlan) {
			pendingDetails.push('位号丝印');
		}
		if (networkPlan) {
			pendingDetails.push(`${networkPlan.routeSnapshots.length} 个连接走线图元网络`);
		}
		setFeedback(`正在交换 ${labelA} 与 ${labelB}：${pendingDetails.join('、')}...`);

		try {
			const results = await Promise.allSettled([
				applyPose(componentA, poseB),
				applyPose(componentB, poseA),
			]);
			const failed = results.find(result => result.status === 'rejected');
			if (failed) {
				throw failed.reason;
			}

			await applyDesignatorSwap(designatorPlan);
			if (networkPlan) {
				await applyConnectedRouteSwap(networkPlan);
			}
			await refreshPcbCalculations();
		}
		catch (error) {
			const networkRollbackErrors = await restoreConnectedRouteSwap(networkPlan);
			const poseRollback = await Promise.allSettled([
				restorePose(componentHitA.primitiveId, poseA),
				restorePose(componentHitB.primitiveId, poseB),
			]);
			const designatorRollbackErrors = await restoreDesignatorSwap(designatorPlan);
			await refreshPcbCalculations();
			const rollbackFailed = networkRollbackErrors.length > 0
				|| designatorRollbackErrors.length > 0
				|| poseRollback.some(result => result.status === 'rejected');
			throw new Error(
				rollbackFailed
					? `交换失败，并且自动恢复未完全成功，请立即撤销或关闭而不保存：${getErrorMessage(error)}`
					: `交换失败，已自动恢复原位置、位号丝印和网络：${getErrorMessage(error)}`,
			);
		}

		swapCommitted = true;
		// 交换已经提交成功，立即刷新候选列表；后续画布事件排空只在后台
		// 清理选中状态，不再让上一对器件继续显示在窗口中。
		resetCandidateSlots();
		// 第二次画布点击和程序化选中可能仍有排队中的 selected 回调。
		// 保持 swapInProgress 锁定，等待旧回调排空后再次清空，避免上一对的
		// 器件2被误记为下一对的器件1。
		let selectionCleanupError;
		try {
			await syncCanvasSelection();
			await new Promise(resolve => setTimeout(resolve, EVENT_SUPPRESSION_MS + 80));
			resetCandidateSlots();
			await syncCanvasSelection();
		}
		catch (error) {
			selectionCleanupError = error;
			console.warn('[器件连续交换] 交换成功，但 PCB 选中状态清理失败。', error);
		}
		finally {
			resetCandidateSlots();
		}
		const designatorSummary = designatorPlan ? '；位号丝印位置和方向已同步交换' : '';
		const networkSummary = networkPlan
			? `；仅交换 ${networkPlan.pairCount} 对引脚所连接的 ${networkPlan.routeSnapshots.length} 个走线/圆弧/过孔图元网络`
			: '';
		const selectionSummary = selectionCleanupError
			? '；PCB 选中状态未完全清理，请点击“全部取消”后再选下一对'
			: '';
		setFeedback(
			`${labelA} ↔ ${labelB} 已交换${designatorSummary}${networkSummary}${selectionSummary}。请运行 DRC，再继续选择下一对器件。`,
			'success',
		);
	}
	catch (error) {
		setFeedback(getErrorMessage(error), 'error');
		try {
			await syncCanvasSelection();
		}
		catch (selectionError) {
			console.warn('[器件连续交换] 失败后无法恢复 PCB 选中状态。', selectionError);
		}
	}
	finally {
		if (swapCommitted) {
			resetCandidateSlots();
		}
		swapInProgress = false;
		chooseNextActiveSlot();
		render();
	}
}

async function assignComponent(hit) {
	if (swapInProgress) {
		return;
	}
	const assignmentEpoch = selectionEpoch;

	if (activeSlotIndex === undefined) {
		chooseNextActiveSlot();
		if (activeSlotIndex === undefined) {
			setFeedback('器件1和器件2仍在候选槽位中，请先取消或重新选取其中一个。', 'warn');
			await syncCanvasSelection();
			return;
		}
	}

	const targetIndex = activeSlotIndex;
	const otherIndex = targetIndex === 0 ? 1 : 0;
	if (slots[otherIndex]?.primitiveId === hit.primitiveId) {
		setFeedback('器件1和器件2不能是同一个器件，请选择另一个器件。', 'warn');
		await syncCanvasSelection();
		return;
	}

	const component = await eda.pcb_PrimitiveComponent.get(hit.primitiveId);
	if (disposed || swapInProgress || assignmentEpoch !== selectionEpoch) {
		return;
	}
	if (!component) {
		setFeedback('点击位置没有读取到器件，请点击器件本体、焊盘或器件文字。', 'warn');
		return;
	}
	const selectedIds = await getSelectedComponentIds([hit]);
	if (disposed || swapInProgress || assignmentEpoch !== selectionEpoch) {
		return;
	}
	const sourcePrimitiveIds = [hit.primitiveId, ...(hit.sourcePrimitiveIds ?? [])];
	if (!sourcePrimitiveIds.some(primitiveId => selectedIds.has(primitiveId))) {
		// 忽略 clearSelected() 后才抵达窗口的旧 selected 回调。
		return;
	}

	const label = getComponentLabel(component, hit.label);
	slots[targetIndex] = { ...hit, label };
	chooseNextActiveSlot();
	render();
	await syncCanvasSelection();
	if (disposed || swapInProgress || assignmentEpoch !== selectionEpoch) {
		return;
	}

	if (slots[0] && slots[1]) {
		await swapSelectedComponents();
	}
	else {
		const nextNumber = activeSlotIndex + 1;
		setFeedback(`已选择器件${targetIndex + 1} ${label}，请继续选择器件${nextNumber}。`);
	}
}

async function handleMouseEvent(eventType, props) {
	if (eventType === SELECTED_EVENT || eventType === CLEAR_SELECTED_EVENT) {
		recordDiagnostic('canvas-event', { eventType, props: selectionSummary(props), epoch: selectionEpoch, swapInProgress, internalSelectionUpdate });
	}
	if (disposed || swapInProgress) {
		return;
	}

	if (eventType === SELECTED_EVENT) {
		if (clearSelectionTimer) {
			clearTimeout(clearSelectionTimer);
			clearSelectionTimer = undefined;
		}

		const request = ++pickRequest;
		const epoch = selectionEpoch;
		let hits;
		try {
			hits = await resolveComponentHits(props);
			recordDiagnostic('resolved-hits', { hits });
		}
		catch (error) {
			setFeedback(`读取所选图元归属失败：${getErrorMessage(error)}`, 'error');
			return;
		}
		if (disposed || swapInProgress || request !== pickRequest || epoch !== selectionEpoch) {
			return;
		}
		if (hits.length === 0) {
			if (!internalSelectionUpdate && Date.now() >= suppressEventsUntil) {
				setFeedback('请点击器件本体、焊盘或器件文字。', 'warn');
			}
			return;
		}

		const containsNewComponent = hits.some(
			item => !slots.some(slot => slot?.primitiveId === item.primitiveId),
		);
		if (
			internalSelectionUpdate
			|| (Date.now() < suppressEventsUntil && !containsNewComponent)
		) {
			return;
		}

		const hit = hits.find(item => !slots.some(slot => slot?.primitiveId === item.primitiveId))
			?? hits[0];
		if (slots.some(slot => slot?.primitiveId === hit.primitiveId)) {
			setFeedback('该器件已在候选槽位中；如需取消，请点击对应的“取消选中”。', 'warn');
			void syncCanvasSelection();
			return;
		}

		void assignComponent(hit).catch((error) => {
			setFeedback(getErrorMessage(error), 'error');
		});
		return;
	}

	if (eventType === CLEAR_SELECTED_EVENT && !internalSelectionUpdate) {
		if (clearSelectionTimer) {
			clearTimeout(clearSelectionTimer);
		}
		clearSelectionTimer = setTimeout(() => {
			clearSelectionTimer = undefined;
			void reconcileSelectedState();
		}, EVENT_SUPPRESSION_MS + 40);
	}
}

function bindControls() {
	document.getElementById('clear-log')?.addEventListener('click', () => {
		void clearErrorLog();
	});
	document.getElementById('copy-log')?.addEventListener('click', () => {
		void copyErrorLog().catch(() => {
			const status = document.getElementById('log-status');
			if (status) {
				status.textContent = '请展开日志并手动全选复制。';
			}
		});
	});
	try {
		const saved = eda.sys_Storage?.getExtensionUserConfig?.(ERROR_LOG_KEY);
		if (typeof saved === 'string' && saved.length < 300000) {
			lastErrorLog = saved;
			const text = document.getElementById('error-log');
			if (text) {
				text.value = saved;
			}
		}
	}
	catch { /* Logging must never prevent the swap window from starting. */ }
	recordDiagnostic('window-start', { version: EXTENSION_VERSION });
	for (const checkbox of [padPickCheckbox, silkPickCheckbox]) {
		checkbox.addEventListener('change', () => {
			void cancelAll(false).then(() => {
				setFeedback('点选方式已更新，候选栏已清空，请重新选择两个器件。');
			}).catch(error => setFeedback(getErrorMessage(error), 'error'));
		});
	}
	for (let index = 0; index < slotElements.length; index += 1) {
		slotElements[index].pick.addEventListener('click', () => {
			if (swapInProgress) {
				return;
			}
			selectionEpoch += 1;
			activeSlotIndex = index;
			render();
			setFeedback(`请在 PCB 画布选择器件${index + 1}。`);
		});
		slotElements[index].cancel.addEventListener('click', () => {
			void cancelSlot(index).catch((error) => {
				setFeedback(getErrorMessage(error), 'error');
			});
		});
	}

	clearAllButton.addEventListener('click', () => {
		void cancelAll().catch((error) => {
			setFeedback(getErrorMessage(error), 'error');
		});
	});

	designatorSyncCheckbox.addEventListener('change', () => {
		if (swapInProgress) {
			return;
		}

		setFeedback(
			designatorSyncCheckbox.checked
				? '位号丝印同步已开启：下一对器件会同时交换 Designator 文字的坐标和方向。'
				: '位号丝印同步已关闭：下一对器件只移动器件本体及其它已开启项目。',
			'warn',
		);
	});

	networkSyncCheckbox.addEventListener('change', () => {
		if (swapInProgress) {
			return;
		}

		if (slots[0] && slots[1]) {
			void swapSelectedComponents().catch((error) => {
				setFeedback(getErrorMessage(error), 'error');
			});
			return;
		}

		setFeedback(
			networkSyncCheckbox.checked
				? '走线网络同步已开启：下一对器件只交换对应引脚实际连接的走线、圆弧和过孔网络。'
				: '网络同步已关闭：下一对器件仍会交换中心位置、旋转方向以及已开启的位号丝印。',
			'warn',
		);
	});
}

async function start() {
	try {
		bindControls();
		void positionWindowAfterMount();
		try {
			const position = await eda.sys_Storage?.getExtensionUserConfig?.('component-swap-window-position-v1');
			recordDiagnostic('window-position-request', { position });
		}
		catch (error) {
			recordDiagnostic('window-position-read-failed', { message: String(error) });
		}
		try {
			eda.pcb_Event.removeEventListener(PICK_LISTENER_ID);
		}
		catch {
			// 没有遗留监听时无需处理。
		}

		eda.pcb_Event.addMouseEventListener(
			PICK_LISTENER_ID,
			'all',
			handleMouseEvent,
			false,
		);
		if (!eda.pcb_Event.isEventListenerAlreadyExist(PICK_LISTENER_ID)) {
			throw new Error('画布点选监听注册失败，请关闭窗口后重试。');
		}

		await cancelAll(false);
		setFeedback('请在 PCB 画布选择器件1。');
		modeStatusElement.textContent = '连续交换已启动';
	}
	catch (error) {
		modeStatusElement.textContent = '启动失败';
		setFeedback(`无法启动连续交换：${getErrorMessage(error)}`, 'error');
		for (const elements of slotElements) {
			elements.pick.disabled = true;
			elements.cancel.disabled = true;
		}
		clearAllButton.disabled = true;
	}
}

function dispose() {
	if (disposed) {
		return;
	}
	disposed = true;
	if (clearSelectionTimer) {
		clearTimeout(clearSelectionTimer);
	}
	try {
		eda.pcb_Event.removeEventListener(PICK_LISTENER_ID);
	}
	catch {
		// 窗口关闭期间忽略清理错误。
	}
	void eda.pcb_SelectControl.clearSelected().catch(() => {});
}

window.addEventListener('pagehide', dispose);
window.addEventListener('beforeunload', dispose);

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => {
		void start();
	});
}
else {
	void start();
}

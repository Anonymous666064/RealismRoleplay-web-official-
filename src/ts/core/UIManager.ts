export class UIManager
{
	public static setUserInterfaceVisible(value: boolean): void
	{
		const el = document.getElementById('ui-container');
		if (el) el.style.display = value ? 'block' : 'none';
	}

	public static setLoadingScreenVisible(value: boolean): void
	{
		const el = document.getElementById('loading-screen');
		if (el) el.style.display = value ? 'flex' : 'none';
	}

	public static setFPSVisible(value: boolean): void
	{
		const stats = document.getElementById('statsBox');
		if (stats) stats.style.display = value ? 'block' : 'none';
		const gui = document.getElementById('dat-gui-container');
		if (gui) gui.style.top = value ? '48px' : '0px';
	}

	/** Realism: Sketchbook's dat.GUI panel (top right) is a developer tool, hidden unless turned on in Settings. */
	public static setDevPanelVisible(value: boolean): void
	{
		const gui = document.getElementById('dat-gui-container');
		if (gui) gui.style.display = value ? '' : 'none';
	}
}

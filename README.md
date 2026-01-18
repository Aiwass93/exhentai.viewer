# ExHentai Viewer

A minimalist, keyboard-driven, highly customizable viewer for exhentai.org and e-hentai.org. Designed for professional, veteran fappers (who need one hand free).

## Features

*  Toggle between Double-Page Spread & Single Page.
*  Support for Right-To-Left (Manga) and Left-To-Right (normal).
*  Preloading pages ensures zero latency between pages.
*  Inspect images in high-res overlays (or fullscreen).
*  Highly customizable (and easy to customize), fully remappable key bindings via GUI menu.
*  Keyboard driven, easy and efficient to control.

## Installation

*  I recommend Violentmonkey because it's foss and the script works well on it.
*  Currently I didn't put it on sleazyfork, you may need to install it manually (copy the script, click "+" of your script manager and paste it.

## Usage & Controls

Below are the default bindings, note that you can completely customize them in the config menu or edit the script (very simple).
All keyboard actions can be reversed by the same keys (for example, if you use `Shift` + `c` to focus on one image, you can undo it by `Shift` + `c`).

| Key | Action | What does it do |
| :--- | :--- | :--- |
| `Left` / `Right` | Navigation | Moves forward/backward based on reading direction. |
| `[` / `]` | Adjust | Shifts the spread by 1 page (fix alignment). |
| `m` | Menu | Opens the configuration and key mapping overlay. |
| `s` | Switch viewer modes | Toggles between **S**pread (2 pages) and **S**ingle page. |
| `d` | Direction | Toggles between RTL (Manga) and LTR. |
| `f` | Fullscreen | Toggles browser fullscreen mode. |
| `c` | Focus | Opens the current image in an overlay. |
| `Shift` + `c` | **Focus Full** | Opens the current image in fullscreen overlay. |
| `/` | Jump | Opens the "Jump to Page" input. |
| `g` | Gallery | Returns to the gallery index. |
| `v` | Enter viewer | Re-activates the viewer if disabled. |
| `x` | Quit viewer | Exits the viewer. |
| `q` / `esc` | Quit | Universal "quit" key to quit focus, full screen, etc. |

## Customization

### The Configuration Menu
Press `m` or click the gear icon in the top-right corner to open the config menu.
*  Visual Settings: Change background color, page gap size, and toast notification duration.
*  Key Remapping: Click on any action button (e.g., `ArrowLeft`) to remove it, or click `+` to record a new keystroke. Changes are saved to `localStorage`.

### Code-Level Configuration
For permanent defaults or logic tweaks, you can modify the `CONFIG` object at the top of the script source. Just replace them with the keys you want.

"""Shared real-browser launch configuration; software Vulkan is CI-only."""
import json
import os
import sys


def chromium_options():
    flags = ['--no-sandbox', '--enable-unsafe-webgpu']
    if sys.platform == 'linux':
        # Browser presentation and Dawn must share a compatible Vulkan path.
        # --enable-gpu opts out of headless forced software compositing. Xvfb
        # supplies DISPLAY; an adapter alone does not prove canvas presentation.
        # Reproduction and recipe: https://github.com/visgl/luma.gl/issues/2874
        defaults = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                    '--ignore-gpu-blocklist', '--enable-gpu',
                    '--enable-features=Vulkan', '--use-vulkan=swiftshader']
        extra = json.loads(os.environ.get('FOLIO_BROWSER_FLAGS', json.dumps(defaults)))
        if not isinstance(extra, list) or not all(isinstance(v, str) for v in extra):
            raise ValueError('FOLIO_BROWSER_FLAGS must be a JSON array of strings')
        flags.extend(extra)
    options = {'headless': os.environ.get('FOLIO_HEADED') != '1', 'args': flags}
    if os.environ.get('CHROMIUM'):
        options['executable_path'] = os.environ['CHROMIUM']
    else:
        options['channel'] = 'chromium'
    return options

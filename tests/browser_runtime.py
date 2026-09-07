"""Shared real-browser launch configuration; software Vulkan is CI-only."""
import json
import os
import sys


def chromium_options():
    flags = ['--no-sandbox', '--enable-unsafe-webgpu']
    if sys.platform == 'linux':
        # Select the system Vulkan implementation. CI pins the ICD to Mesa's
        # lavapipe; merely installing it leaves Chromium on bundled SwiftShader.
        defaults = ['--enable-features=Vulkan', '--use-angle=vulkan',
                    '--use-vulkan=native', '--disable-vulkan-surface']
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

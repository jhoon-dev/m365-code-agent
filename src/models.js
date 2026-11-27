'use strict';
const { t } = require('./localization');

class ModelController {
  constructor(host) {
    this.host = host;
  }
  async refreshModels() {
    const host = this.host;
    if (host.starting || host.switchingBrowser || host.agent?.running) return;
    host.starting = true;
    host.stopRequested = false;
    host.post({ type: 'busy' });
    try {
      const browser = await host.ensureBrowser();
      browser.cancelled = false;
      host.modelChoices = await browser.models((text) => host.post({ type: 'status', text }));
      host.post({ type: 'models', choices: host.modelChoices, selected: host.selectedModel });
    } finally {
      host.starting = false;
      host.post({ type: 'idle' });
    }
  }
  async chooseModel(id) {
    const host = this.host;
    if (host.starting || host.switchingBrowser || host.agent?.running) return;
    if (!id) {
      host.selectedModel = '';
      return;
    }
    host.starting = true;
    host.post({ type: 'busy' });
    try {
      const browser = await host.ensureBrowser();
      browser.cancelled = false;
      const label = await browser.selectModel(id, (text) => host.post({ type: 'status', text }));
      host.selectedModel = id;
      host.post({ type: 'models', choices: host.modelChoices, selected: id });
      host.post({ type: 'status', text: t('M365 모델 선택: ') + label });
    } catch (error) {
      host.post({ type: 'models', choices: host.modelChoices, selected: host.selectedModel });
      throw error;
    } finally {
      host.starting = false;
      host.post({ type: 'idle' });
    }
  }
}
module.exports = { ModelController };

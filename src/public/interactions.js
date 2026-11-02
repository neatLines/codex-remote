import { renderMarkdown } from './markdown.js';

const COMMAND_METHODS = new Set(['item/commandExecution/requestApproval', 'execCommandApproval']);
const FILE_METHODS = new Set(['item/fileChange/requestApproval', 'applyPatchApproval']);
const QUESTION_METHODS = new Set(['item/tool/requestUserInput', 'tool/requestUserInput']);

export function interactionKind(request) {
  if (QUESTION_METHODS.has(request.method)) return 'question';
  if (COMMAND_METHODS.has(request.method)) return 'command';
  if (FILE_METHODS.has(request.method)) return 'file';
  if (request.method === 'item/permissions/requestApproval') return 'permissions';
  if (request.method === 'mcpServer/elicitation/request') return 'elicitation';
  if (request.method === 'item/tool/call' && /(^|[./_])request_user_input(_async)?$/.test(request.params?.tool || '')) return 'dynamicQuestion';
  return 'unsupported';
}

export function decisionLabel(decision) {
  if (typeof decision === 'string') return ({ accept: '允许本次', acceptForSession: '本会话允许',
    decline: '拒绝', cancel: '拒绝并停止' })[decision] || decision;
  if (decision?.acceptWithExecpolicyAmendment) return '允许并保存命令规则';
  if (decision?.applyNetworkPolicyAmendment) {
    const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
    return `${rule?.action === 'deny' ? '禁止' : '允许'}并保存网络规则：${rule?.host || ''}`;
  }
  return '应用所示规则';
}

export function validateFormValue(value, schema, label = '表单') {
  if (!schema || typeof schema !== 'object') return value;
  if (value === undefined) return value;
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) throw new Error(`${label}：请选择有效选项`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) throw new Error(`${label}：选项无效`);
  const branches = schema.anyOf || schema.oneOf;
  if (branches) {
    for (const branch of branches) {
      try { validateFormValue(value, branch, label); return value; } catch { /* try another allowed branch */ }
    }
    throw new Error(`${label}：格式不符合要求`);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length && !types.includes(actual) && !(actual === 'number' && Number.isInteger(value) && types.includes('integer'))) {
    throw new Error(`${label}：数据类型不符合要求`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) throw new Error(`${label}：内容过短`);
    if (schema.maxLength != null && value.length > schema.maxLength) throw new Error(`${label}：内容过长`);
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${label}：请输入邮箱地址`);
    if (schema.format === 'uri') { try { new URL(value); } catch { throw new Error(`${label}：请输入完整 URL`); } }
  }
  if (typeof value === 'number' && (!Number.isFinite(value) ||
      (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) {
    throw new Error(`${label}：数值超出允许范围`);
  }
  if (Array.isArray(value)) {
    if ((schema.minItems != null && value.length < schema.minItems) || (schema.maxItems != null && value.length > schema.maxItems)) throw new Error(`${label}：选择数量不符合要求`);
    value.forEach((item) => validateFormValue(item, schema.items, label));
  }
  if (actual === 'object') {
    for (const name of schema.required || []) {
      if (value[name] === undefined || value[name] === '') throw new Error(`${schema.properties?.[name]?.title || name}：请填写此项`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties || {}, name)) throw new Error(`${label}：包含未请求的字段`);
      validateFormValue(item, schema.properties?.[name], name);
    }
  }
  return value;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function pretty(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (text || '').slice(0, 60000);
}

function details(parent, title, value) {
  if (value === undefined || value === null || value === '') return;
  const element = node('details', 'interaction-details');
  element.appendChild(node('summary', '', title));
  element.appendChild(node('pre', '', pretty(value)));
  parent.appendChild(element);
}

function enumOptions(schema) {
  if (schema.enum) return schema.enum.map((value, i) => ({ value, title: schema.enumNames?.[i] || String(value) }));
  const variants = schema.oneOf || schema.anyOf;
  return variants?.every((entry) => Object.hasOwn(entry, 'const'))
    ? variants.map((entry) => ({ value: entry.const, title: entry.title || String(entry.const) })) : null;
}

function formField(parent, name, schema, required, depth = 0) {
  if (depth > 10) throw new Error('表单层级过多，请在桌面端处理');
  const alternatives = schema.anyOf?.filter((entry) => entry.type !== 'null');
  if (!enumOptions(schema) && alternatives?.length === 1) schema = alternatives[0];
  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
  const wrap = node('label', 'interaction-field');
  const label = schema.title || name;
  wrap.appendChild(node('span', 'interaction-field-title', `${label}${required ? ' *' : ''}`));
  if (schema.description) wrap.appendChild(node('small', '', schema.description));
  parent.appendChild(wrap);
  let read;
  const choices = enumOptions(schema);
  if (choices) {
    const select = node('select');
    select.appendChild(node('option', '', '请选择…'));
    select.options[0].value = '';
    choices.forEach((choice, index) => { const option = node('option', '', choice.title); option.value = String(index); select.appendChild(option); });
    if (schema.default !== undefined) select.value = String(choices.findIndex((choice) => choice.value === schema.default));
    wrap.appendChild(select);
    read = () => select.value === '' ? undefined : choices[Number(select.value)]?.value;
  } else if (type === 'array' && enumOptions(schema.items || {})) {
    const list = node('div', 'interaction-options');
    const inputs = enumOptions(schema.items).map((choice) => {
      const item = node('label', 'interaction-option');
      const input = node('input'); input.type = 'checkbox'; input.checked = schema.default?.includes(choice.value) || false;
      item.appendChild(input); item.appendChild(node('span', '', choice.title)); list.appendChild(item);
      return { input, value: choice.value };
    });
    wrap.appendChild(list);
    read = () => inputs.filter(({ input }) => input.checked).map(({ value }) => value);
  } else if (type === 'object' && schema.properties) {
    const group = node('fieldset', 'interaction-group'); wrap.appendChild(group);
    const fields = Object.entries(schema.properties).map(([key, child]) => [key, formField(group, key, child, schema.required?.includes(key), depth + 1)]);
    read = () => Object.fromEntries(fields.map(([key, collect]) => [key, collect()]).filter(([, value]) => value !== undefined));
  } else {
    const complex = type === 'array' || type === 'object';
    const input = node(complex ? 'textarea' : 'input');
    if (complex) { input.rows = 4; input.placeholder = '填写 JSON'; }
    else input.type = type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(type) ? 'number' :
      schema.format === 'email' ? 'email' : schema.format === 'uri' ? 'url' : schema.isSecret || schema.format === 'password' ? 'password' : 'text';
    if (type === 'boolean') input.checked = schema.default === true;
    else if (schema.default !== undefined) input.value = complex ? JSON.stringify(schema.default) : String(schema.default);
    if (['number', 'integer'].includes(type)) {
      input.step = type === 'integer' ? '1' : 'any';
      if (schema.minimum != null) input.min = String(schema.minimum);
      if (schema.maximum != null) input.max = String(schema.maximum);
    }
    if (schema.maxLength != null) input.maxLength = schema.maxLength;
    input.autocomplete = 'off';
    wrap.appendChild(input);
    read = () => {
      if (type === 'boolean') return input.checked;
      if (input.value === '') return undefined;
      if (complex) { try { return JSON.parse(input.value); } catch { throw new Error(`${label}：JSON 格式无效`); } }
      return ['number', 'integer'].includes(type) ? Number(input.value) : input.value;
    };
  }
  return () => {
    const value = read();
    if (required && (value === undefined || value === '')) throw new Error(`${label}：请填写此项`);
    return validateFormValue(value, schema, label);
  };
}

function questionsForm(parent, questions) {
  const collectors = questions.map((question, index) => {
    const field = node('fieldset', 'interaction-question');
    field.appendChild(node('legend', '', question.header || `问题 ${index + 1}`));
    const text = node('div'); renderMarkdown(text, question.question); field.appendChild(text);
    const choices = [];
    const groupName = `question-${index}-${Math.random().toString(36).slice(2)}`;
    for (const option of question.options || []) {
      const row = node('label', 'interaction-option');
      const radio = node('input'); radio.type = 'radio'; radio.name = groupName;
      const description = node('span'); description.appendChild(node('strong', '', option.label));
      if (option.description) description.appendChild(node('small', '', option.description));
      row.appendChild(radio); row.appendChild(description); field.appendChild(row);
      choices.push({ radio, value: option.label });
    }
    let custom;
    let other;
    if (!question.options?.length || question.isOther || question.isSecret) {
      if (question.options?.length) {
        const row = node('label', 'interaction-option');
        other = node('input'); other.type = 'radio'; other.name = groupName;
        row.appendChild(other); row.appendChild(node('span', '', '自定义回答')); field.appendChild(row);
      }
      custom = node(question.isSecret ? 'input' : 'textarea');
      if (question.isSecret) custom.type = 'password'; else custom.rows = 3;
      custom.autocomplete = 'off'; custom.placeholder = question.isSecret ? '输入私密回答' : '输入回答…';
      custom.oninput = () => { if (other) other.checked = true; };
      field.appendChild(custom);
    }
    parent.appendChild(field);
    return () => {
      const selected = choices.find(({ radio }) => radio.checked);
      const answer = other?.checked || !choices.length ? custom?.value.trim() : selected?.value;
      if (!answer) throw new Error(`${question.header || `问题 ${index + 1}`}：请选择或填写答案`);
      return [question.id, { answers: [answer] }];
    };
  });
  return () => Object.fromEntries(collectors.map((collect) => collect()));
}

export function createInteractionCard(request, { onSubmit, onSync }) {
  const kind = interactionKind(request);
  const params = request.params || {};
  const card = node('section', 'interaction-card');
  card.dataset.requestId = String(request.id);
  const titles = { question: '需要你的回答', dynamicQuestion: '需要你的回答', command: '命令执行审批',
    file: '文件修改审批', permissions: '权限申请', elicitation: '插件需要确认', unsupported: '需要在本机处理的请求' };
  card.appendChild(node('h3', '', titles[kind]));
  const status = node('p', 'interaction-status'); status.setAttribute('role', 'status'); card.appendChild(status);
  const form = node('form');
  const fieldset = node('fieldset', 'interaction-fields'); form.appendChild(fieldset); card.appendChild(form);
  const actions = node('div', 'interaction-actions'); fieldset.appendChild(actions);
  let resolved = false;
  let submitting = request.state === 'submitting';
  const setState = (state, message) => {
    if (resolved) return;
    submitting = state === 'submitting'; fieldset.disabled = submitting;
    card.classList.toggle('is-submitting', submitting);
    status.textContent = message || (submitting ? '答案已提交，等待 Codex 确认…' : params.isBlocking === false ? '可继续工作，等待你的回答' : '等待你的操作');
  };
  const submit = async (response) => {
    if (resolved || submitting) return;
    setState('submitting');
    try { await onSubmit(response); api.resolve('已处理'); }
    catch (error) { setState('pending', error.message || '提交失败，请重试'); }
  };
  const button = (label, response, className = '') => {
    const element = node('button', `btn-small ${className}`, label); element.type = 'button';
    element.onclick = () => submit(typeof response === 'function' ? response() : response);
    actions.appendChild(element); return element;
  };
  const submitForm = (collect) => {
    const element = node('button', 'btn-primary', '提交回答'); element.type = 'submit'; actions.appendChild(element);
    form.onsubmit = (event) => {
      event.preventDefault();
      try { const response = collect(); submit(response); }
      catch (error) { setState('pending', error.message); }
    };
  };
  const text = (source) => { const element = node('div', 'interaction-description'); renderMarkdown(element, source); fieldset.insertBefore(element, actions); };
  try {
    if (kind === 'question' || kind === 'dynamicQuestion') {
      const args = kind === 'dynamicQuestion' ? params.arguments || {} : params;
      const fields = node('div'); fieldset.insertBefore(fields, actions);
      if (!Array.isArray(args.questions) || !args.questions.length) throw new Error('问答数据不完整，请在本机处理');
      const questions = kind === 'dynamicQuestion' ? args.questions.map((question, index) => ({
        ...question,
        id: question.id || `question_${index + 1}`,
        question: question.question || question.title || '',
        options: question.options?.map((option) => typeof option === 'string' ? { label: option } : option),
        isOther: question.isOther ?? true,
      })) : args.questions;
      const collect = questionsForm(fields, questions);
      submitForm(() => {
        const answers = { answers: collect() };
        return { result: kind === 'dynamicQuestion'
          ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(answers) }] } : answers };
      });
      // A question has no implicit "empty means cancel" response in this protocol.
      // Cancelling the turn is offered by the regular Stop control.
    } else if (kind === 'command' || kind === 'file') {
      if (params.reason) text(params.reason);
      const detail = node('div'); fieldset.insertBefore(detail, actions);
      details(detail, params.kind === 'writeStdin' ? '将发送到终端的内容' : '命令 / 工作目录', {
        command: params.command, cwd: params.cwd, grantRoot: params.grantRoot,
      });
      details(detail, '本次请求的额外权限', params.additionalPermissions);
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel'];
      for (const decision of decisions) {
        if (typeof decision === 'object') details(detail, decisionLabel(decision), decision);
        button(decisionLabel(decision), { result: { decision } }, typeof decision === 'string' && ['decline', 'cancel'].includes(decision) ? 'danger-text' : '');
      }
    } else if (kind === 'permissions') {
      if (params.reason) text(params.reason);
      text(`工作目录：\`${params.cwd || ''}\``);
      const list = node('div'); fieldset.insertBefore(list, actions);
      details(list, '请求的权限（仅授予这里列出的范围）', params.permissions);
      const groups = Object.entries(params.permissions || {}).filter(([, value]) => value != null).map(([key, value]) => {
        const row = node('label', 'interaction-option'); const checkbox = node('input'); checkbox.type = 'checkbox';
        row.appendChild(checkbox); row.appendChild(node('span', '', key === 'network' ? '授予请求的网络权限' : '授予请求的文件权限'));
        list.appendChild(row); return { key, value, checkbox };
      });
      const grant = (scope) => ({ result: { permissions: Object.fromEntries(groups.filter(({ checkbox }) => checkbox.checked).map(({ key, value }) => [key, value])), scope } });
      button('提交所选权限（本次）', () => grant('turn'));
      button('提交所选权限（本会话）', () => grant('session'));
      button('全部拒绝', { result: { permissions: {}, scope: 'turn' } }, 'danger-text');
    } else if (kind === 'elicitation') {
      text(params.message || params.description || params.title || '插件请求确认');
      if (params.mode === 'url') {
        let url;
        try { url = new URL(params.url); } catch { throw new Error('插件返回的链接无效'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('插件链接不受支持，请在本机处理');
        const link = node('a', 'btn-small', '打开验证页面'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        fieldset.insertBefore(link, actions);
        button('已在验证页面完成', { result: { action: 'accept', content: null } });
      } else if (['form', 'openai/form', 'openaiForm'].includes(params.mode)) {
        const schema = params.requestedSchema;
        if (!schema || schema.type !== 'object' || !schema.properties) throw new Error('插件表单格式不受支持，请在本机处理');
        const group = node('div'); fieldset.insertBefore(group, actions);
        const fields = Object.entries(schema.properties).map(([key, value]) => [key, formField(group, key, value, schema.required?.includes(key))]);
        submitForm(() => {
          const content = Object.fromEntries(fields.map(([key, collect]) => [key, collect()]).filter(([, value]) => value !== undefined));
          validateFormValue(content, schema);
          return { result: { action: 'accept', content } };
        });
      } else text('该验证需要在本机 Codex 完成，可在此取消请求。');
      button('拒绝', { result: { action: 'decline', content: null } }, 'danger-text');
      button('取消', { result: { action: 'cancel', content: null } });
    } else {
      text(`当前网页无法执行此类请求：\`${request.method}\`。请在本机处理，或拒绝此请求让任务返回错误。`);
      button('拒绝未支持的请求', { error: { code: -32601, message: `Web 客户端不支持 ${request.method}，用户已拒绝请求` } }, 'danger-text');
    }
  } catch (error) {
    status.textContent = error.message;
    fieldset.replaceChildren(); fieldset.appendChild(actions); actions.replaceChildren();
    button('拒绝此请求', { error: { code: -32602, message: error.message } }, 'danger-text');
  }
  const sync = node('button', 'btn-ghost interaction-sync', '同步处理状态'); sync.type = 'button';
  sync.onclick = () => onSync?.(); card.appendChild(sync);
  const api = {
    element: card,
    requestEpoch: request.requestEpoch,
    update(next) { request = next; setState(next.state || 'pending'); },
    resolve(message = '已处理') {
      if (resolved) { status.textContent = message; return; }
      resolved = true; fieldset.disabled = true;
      // Erase password and free-text answers once no longer needed.
      for (const input of form.querySelectorAll('input, textarea')) input.value = '';
      form.replaceChildren(); sync.remove();
      status.textContent = message; card.classList.add('is-resolved');
    },
  };
  setState(request.state || 'pending', status.textContent || undefined);
  return api;
}

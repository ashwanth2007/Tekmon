/**
 * Data Mapper — app.js
 * Handles CSV/XLSX parsing, column mapping UI, and webhook dispatch
 * Webhook: https://tekmon.app.n8n.cloud/webhook/2d13aaa3-607b-4b21-b942-74ab557150d0
 */

const WEBHOOK = 'https://tekmon.app.n8n.cloud/webhook/2d13aaa3-607b-4b21-b942-74ab557150d0';

// ─── Required field definitions ───────────────────────────────────────────────
const REQUIRED_FIELDS = {
  leads: [
    { key: 'first_name', label: 'First Name' },
    { key: 'last_name', label: 'Last Name' },
    { key: 'company_domain', label: 'Company Domain' },
  ],
  companies: [
    { key: 'company_name', label: 'Company Name' },
  ],
};

// Optional fields shown in mapping UI but not required for submit
const OPTIONAL_FIELDS = {
  leads: [],
  companies: [
    { key: 'company_domain', label: 'Company Domain' },
  ],
};

// ─── State per page ────────────────────────────────────────────────────────────
const state = {
  leads: { headers: [], rows: [], fileName: '' },
  companies: { headers: [], rows: [], fileName: '' },
};

// ─── Nav routing ──────────────────────────────────────────────────────────────
function initNav() {
  const links = document.querySelectorAll('.nav-link[data-page]');
  links.forEach(link => {
    link.addEventListener('click', () => switchPage(link.dataset.page));
  });
  // Dashboard cards also navigate
  document.querySelectorAll('.dash-card[data-page]').forEach(card => {
    card.addEventListener('click', () => switchPage(card.dataset.page));
  });
  // Default to dashboard
  switchPage('dashboard');
}

function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link[data-page]').forEach(l => l.classList.remove('active'));
  document.getElementById(`page-${pageId}`).classList.add('active');
  document.querySelector(`.nav-link[data-page="${pageId}"]`).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── File input wiring ────────────────────────────────────────────────────────
function showUploadModal(onConfirm) {
  const overlay = document.getElementById('row-limit-modal');
  overlay.classList.add('visible');

  function cleanup() {
    overlay.classList.remove('visible');
    document.getElementById('modal-ok').removeEventListener('click', handleOk);
    document.getElementById('modal-cancel').removeEventListener('click', handleCancel);
    overlay.removeEventListener('click', handleBackdrop);
  }

  function handleOk() { cleanup(); onConfirm(); }
  function handleCancel() { cleanup(); }
  function handleBackdrop(e) { if (e.target === overlay) cleanup(); }

  document.getElementById('modal-ok').addEventListener('click', handleOk);
  document.getElementById('modal-cancel').addEventListener('click', handleCancel);
  overlay.addEventListener('click', handleBackdrop);
}

function initUploads() {
  ['leads', 'companies'].forEach(type => {
    const zone = document.getElementById(`zone-${type}`);
    const input = document.getElementById(`file-input-${type}`);
    let picking = false;

    zone.addEventListener('click', () => {
      if (picking) return;          // guard: ignore the click fired when picker closes
      showUploadModal(() => {
        picking = true;
        input.click();
      });
    });

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      showUploadModal(() => handleFile(file, type));
    });

    input.addEventListener('change', () => {
      picking = false;              // picker is done, re-enable the zone click
      if (input.files[0]) handleFile(input.files[0], type);
      input.value = '';
    });

    // Also reset flag if user cancels the picker (focus returns without change)
    input.addEventListener('cancel', () => { picking = false; });
    window.addEventListener('focus', () => { picking = false; }, { once: false });

    document.getElementById(`btn-remove-${type}`).addEventListener('click', () => resetPage(type));
    document.getElementById(`btn-submit-${type}`).addEventListener('click', () => submitData(type));

    // "Submit Another Response" — resets the upload result screen back to upload zone
    const resultBtn = document.getElementById(`btn-result-${type}`);
    if (resultBtn) resultBtn.addEventListener('click', () => resetPage(type));
  });
}

// ─── File parsing ─────────────────────────────────────────────────────────────
function handleFile(file, type) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    showStatus(type, 'error', 'Unsupported file format. Please upload a CSV or XLSX file.');
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    try {
      let headers = [], rows = [];

      if (ext === 'csv') {
        const result = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
        headers = result.meta.fields || [];
        rows = result.data;
      } else {
        const wb = XLSX.read(e.target.result, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (json.length < 1) throw new Error('Empty sheet');
        headers = json[0].map(String);
        rows = json.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => obj[h] = String(row[i] ?? '').trim());
          return obj;
        });
      }

      if (headers.length === 0) {
        showStatus(type, 'error', 'Could not detect any column headers in this file.');
        return;
      }

      // ── Strip blank rows immediately at parse time ──────────────────────────
      // A row is blank if every single cell value is empty after trimming.
      // This handles Excel ghost rows, CSV trailing newlines, etc.
      rows = rows.filter(row =>
        Object.values(row).some(v => String(v).trim() !== '')
      );
      // ────────────────────────────────────────────────────────────────────────

      if (rows.length === 0) {
        showStatus(type, 'error', 'No data rows found in this file after removing blank rows.');
        return;
      }

      state[type] = { headers, rows, fileName: file.name };
      renderMappingUI(type);
    } catch (err) {
      showStatus(type, 'error', 'Failed to parse file: ' + err.message);
    }
  };

  if (ext === 'csv') reader.readAsText(file);
  else reader.readAsBinaryString(file);
}

// ─── Mapping UI ───────────────────────────────────────────────────────────────
function renderMappingUI(type) {
  const { headers, rows, fileName } = state[type];

  // Hide upload zone, show mapping section
  document.getElementById(`zone-${type}`).style.display = 'none';
  const section = document.getElementById(`mapping-${type}`);
  section.classList.add('visible');

  // File meta
  document.getElementById(`meta-name-${type}`).textContent = fileName;
  document.getElementById(`meta-rows-${type}`).textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''} detected`;

  // Required mappings
  const mappingGrid = document.getElementById(`mapping-grid-${type}`);
  mappingGrid.innerHTML = '';

  REQUIRED_FIELDS[type].forEach(field => {
    const row = document.createElement('div');
    row.className = 'mapping-row';

    const label = document.createElement('div');
    label.className = 'mapping-field-name req';
    label.textContent = field.label;

    const arrow = document.createElement('div');
    arrow.className = 'mapping-arrow';
    arrow.innerHTML = '&#8594;';

    const select = document.createElement('select');
    select.className = 'mapping-select';
    select.id = `map-${type}-${field.key}`;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '- Select column -';
    select.appendChild(placeholder);

    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      if (autoMatch(h, field.key)) opt.selected = true;
      select.appendChild(opt);
    });

    if (select.value) select.classList.add('mapped');
    select.addEventListener('change', () => {
      select.classList.toggle('mapped', select.value !== '');
      syncSelects(type);
    });

    row.appendChild(label);
    row.appendChild(arrow);
    row.appendChild(select);
    mappingGrid.appendChild(row);
  });

  // Optional fields
  (OPTIONAL_FIELDS[type] || []).forEach(field => {
    const row = document.createElement('div');
    row.className = 'mapping-row';

    const label = document.createElement('div');
    label.className = 'mapping-field-name';
    label.textContent = field.label + ' (optional)';
    label.style.opacity = '0.65';

    const arrow = document.createElement('div');
    arrow.className = 'mapping-arrow';
    arrow.innerHTML = '&#8594;';

    const select = document.createElement('select');
    select.className = 'mapping-select';
    select.id = `map-${type}-${field.key}`;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '- Skip this field -';
    select.appendChild(placeholder);

    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      if (autoMatch(h, field.key)) opt.selected = true;
      select.appendChild(opt);
    });

    if (select.value) select.classList.add('mapped');
    select.addEventListener('change', () => {
      select.classList.toggle('mapped', select.value !== '');
      syncSelects(type);
    });

    row.appendChild(label);
    row.appendChild(arrow);
    row.appendChild(select);
    mappingGrid.appendChild(row);
  });

  // Run once after render to lock out auto-matched columns
  syncSelects(type);

  // Other fields
  const requiredKeys = REQUIRED_FIELDS[type].map(f => f.key);
  const otherHeaders = headers; // we list all as "other" below; mapping will subtract required
  const otherList = document.getElementById(`other-fields-${type}`);
  otherList.innerHTML = '';
  otherHeaders.forEach(h => {
    const tag = document.createElement('span');
    tag.className = 'field-tag';
    tag.textContent = h;
    otherList.appendChild(tag);
  });

  hideStatus(type);
}

// Prevent the same column being mapped to more than one field.
// Runs after every select change and once on initial render.
function syncSelects(type) {
  const allSelects = Array.from(
    document.querySelectorAll(`#mapping-${type} .mapping-select`)
  );

  // Collect every value currently chosen (ignoring blanks)
  const taken = new Set(
    allSelects.map(s => s.value).filter(v => v !== '')
  );

  allSelects.forEach(sel => {
    const currentVal = sel.value;
    Array.from(sel.options).forEach(opt => {
      if (opt.value === '') return;          // never touch the placeholder
      if (opt.value === currentVal) {
        opt.disabled = false;                // always keep the own selection enabled
      } else {
        opt.disabled = taken.has(opt.value); // disable if taken by another select
      }
    });
  });
}

// Auto-match helper: fuzzy-ish column name to required key
function autoMatch(header, key) {
  const h = header.toLowerCase().replace(/[\s_\-\.]/g, '');
  const k = key.toLowerCase().replace(/_/g, '');

  const aliases = {
    firstname: ['firstname', 'fname', 'givenname'],
    lastname: ['lastname', 'lname', 'surname', 'familyname'],
    companydomain: ['companydomain', 'domain', 'website', 'companywebsite', 'url'],
    companyname: ['companyname', 'company', 'organization', 'org', 'name'],
  };

  return (aliases[k] || [k]).includes(h);
}

// ─── Reset page ───────────────────────────────────────────────────────────────
function resetPage(type) {
  state[type] = { headers: [], rows: [], fileName: '' };
  document.getElementById(`zone-${type}`).style.display = '';

  const section = document.getElementById(`mapping-${type}`);
  section.classList.remove('visible');
  section.style.display = '';

  // Restore all children hidden during showUploadResult
  Array.from(section.children).forEach(child => { child.style.display = ''; });

  section.querySelector('.mapping-grid').innerHTML = '';

  // Hide result screen
  const result = document.getElementById(`result-${type}`);
  if (result) result.className = 'upload-result';

  hideStatus(type);
}

// --- Submit ---
async function submitData(type) {
  const { rows, headers } = state[type];
  if (!rows.length) { showStatus(type, 'error', 'No data to send.'); return; }

  // Validate extra required inputs (companies only)
  if (type === 'companies') {
    const jobTitlesEl = document.getElementById('input-job-titles');
    const leadsCountEl = document.getElementById('input-leads-count');
    if (!jobTitlesEl.value.trim()) {
      showStatus(type, 'error', 'Please enter at least one Target Job Title before submitting.');
      return;
    }
    const leadsCount = parseInt(leadsCountEl.value, 10);
    if (!leadsCountEl.value || isNaN(leadsCount) || leadsCount < 1 || leadsCount > 49) {
      showStatus(type, 'error', 'Please enter a valid number of Leads to Generate (1 - 49).');
      return;
    }
  }

  // Collect mapping
  const mapping = {};
  let allMapped = true;
  REQUIRED_FIELDS[type].forEach(field => {
    const sel = document.getElementById(`map-${type}-${field.key}`);
    if (!sel || !sel.value) { allMapped = false; return; }
    mapping[field.key] = sel.value;
  });

  if (!allMapped) {
    showStatus(type, 'error', 'Please map all required fields before submitting.');
    return;
  }

  // Build payload
  const mappingOptional = {};
  (OPTIONAL_FIELDS[type] || []).forEach(field => {
    const sel = document.getElementById(`map-${type}-${field.key}`);
    if (sel && sel.value) mappingOptional[field.key] = sel.value;
  });

  const allMappedKeys = [...Object.values(mapping), ...Object.values(mappingOptional)];
  const allRecords = rows.map(row => {
    const record = {};
    // Required mapped fields
    REQUIRED_FIELDS[type].forEach(field => {
      record[field.key] = String(row[mapping[field.key]] ?? '').trim();
    });
    // Optional mapped fields
    (OPTIONAL_FIELDS[type] || []).forEach(field => {
      if (mappingOptional[field.key]) {
        record[field.key] = String(row[mappingOptional[field.key]] ?? '').trim();
      }
    });
    // All other raw fields
    headers.forEach(h => {
      if (!allMappedKeys.includes(h)) {
        record[h] = String(row[h] ?? '').trim();
      }
    });
    return record;
  });

  // Drop rows that are fully blank (ghost rows from Excel/CSV)
  const nonBlankRecords = allRecords.filter(record =>
    Object.values(record).some(v => v !== '')
  );

  // Drop rows where any required field is missing a value
  const requiredKeys = REQUIRED_FIELDS[type].map(f => f.key);
  const data = nonBlankRecords.filter(record =>
    requiredKeys.every(k => record[k] !== '')
  );

  const skipped = rows.length - data.length;

  const btn = document.getElementById(`btn-submit-${type}`);

  if (data.length === 0) {
    showStatus(type, 'error', 'No valid rows found after filtering empty/incomplete records. Check that your required fields are mapped and have values.');
    btn.disabled = false;
    return;
  }

  const payload = {
    list_type: type === 'leads' ? 'leads' : 'companies',
    total: data.length,
    skipped,
    data,
  };

  // Attach extra fields for companies
  if (type === 'companies') {
    payload.target_job_titles = document.getElementById('input-job-titles').value.trim();
    payload.leads_per_company = parseInt(document.getElementById('input-leads-count').value, 10);
    const geographiesVal = document.getElementById('input-geographies').value.trim();
    payload.target_geographies = geographiesVal || null;
  }

  btn.disabled = true;
  showStatus(type, 'loading', 'Sending data to webhook...');

  try {
    const resp = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const skippedNote = skipped > 0
        ? ` ${skipped} row${skipped !== 1 ? 's' : ''} skipped (empty or missing required fields).`
        : '';
      const label = type === 'leads' ? 'lead' : 'company record';
      const plural = data.length !== 1 ? (type === 'leads' ? 'leads' : 'company records') : label;
      showUploadResult(type, 'success',
        'Data Sent Successfully',
        `${data.length} ${plural} sent successfully. Your data is being processed.${skippedNote}`);
    } else {
      showUploadResult(type, 'error',
        'Data Not Sent',
        `The webhook responded with status ${resp.status}. Please try again after some time.`);
    }
  } catch (err) {
    showUploadResult(type, 'error',
      'Data Not Sent',
      'Could not reach the webhook. Please check your connection and try again after some time.');
  } finally {
    btn.disabled = false;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function showStatus(type, variant, message) {
  const bar = document.getElementById(`status-${type}`);
  bar.className = `status-bar ${variant} visible`;

  if (variant === 'loading') {
    bar.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
  } else if (variant === 'success') {
    bar.innerHTML = `<span style="font-size:16px">&#10003;</span><span>${message}</span>`;
  } else {
    bar.innerHTML = `<span style="font-size:16px">&#9888;</span><span>${message}</span>`;
  }
}

function hideStatus(type) {
  const bar = document.getElementById(`status-${type}`);
  bar.className = 'status-bar';
  bar.innerHTML = '';
}

// Show the full-page result screen (success or error) for upload pages
function showUploadResult(type, state, title, sub) {
  const resultEl = document.getElementById(`result-${type}`);
  const iconEl = document.getElementById(`result-icon-${type}`);
  const titleEl = document.getElementById(`result-title-${type}`);
  const subEl = document.getElementById(`result-sub-${type}`);
  const mappingEl = document.getElementById(`mapping-${type}`);

  // Update text
  titleEl.textContent = title;
  subEl.textContent = sub;

  // Swap icon
  if (state === 'error') {
    iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
    </svg>`;
  } else {
    iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;
  }

  // Hide every child EXCEPT the result div — keep the wrapper visible
  if (mappingEl) {
    Array.from(mappingEl.children).forEach(child => {
      if (child !== resultEl) child.style.display = 'none';
    });
  }

  hideStatus(type);
  resultEl.className = `upload-result ${state} visible`;
}

// ─── Theme Toggle ─────────────────────────────────────────────────────────────
function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  const html = document.documentElement;

  // Restore saved preference (default: dark)
  const saved = localStorage.getItem('tekmon-theme') || 'light';
  html.setAttribute('data-theme', saved);

  btn.addEventListener('click', () => {
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('tekmon-theme', next);
  });
}

// ─── Lead Intake Form ─────────────────────────────────────────────────────────
function initIntakeForm() {
  const form = document.getElementById('intake-form');
  if (!form) return;

  const successEl = document.getElementById('intake-success');
  const btnAgain = document.getElementById('btn-intake-again');
  const toast = document.getElementById('intake-toast');
  const toastClose = document.getElementById('intake-toast-close');

  // Toast helpers
  let toastTimer;
  function showToast(msg) {
    document.getElementById('intake-toast-msg').textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 6000);
  }
  toastClose.addEventListener('click', () => toast.classList.remove('visible'));

  // Gather checked values from a container
  function getChecked(containerId) {
    return Array.from(
      document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)
    ).map(cb => cb.value);
  }

  // Highlight / clear error on a field
  function markError(el) { el.classList.add('intake-error'); }
  function clearError(el) {
    el.classList.remove('intake-error');
    el.addEventListener('input', () => el.classList.remove('intake-error'), { once: true });
  }

  // Submit handler
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const jobTitlesEl = document.getElementById('intake-job-titles');
    const geographiesEl = document.getElementById('intake-geographies');
    const leadsCountEl = document.getElementById('intake-leads-count');

    const jobTitles = jobTitlesEl.value.trim();
    const industries = document.getElementById('intake-industries').value.trim();
    const geographies = geographiesEl.value.trim();
    const keywords = document.getElementById('intake-keywords').value.trim();
    const leadsCount = parseInt(leadsCountEl.value, 10);
    const employees = getChecked('intake-employees');
    const revenue = getChecked('intake-revenue');
    const context = document.getElementById('intake-context').value.trim();

    // Validate required fields
    let valid = true;

    if (!jobTitles) { markError(jobTitlesEl); valid = false; } else clearError(jobTitlesEl);
    if (!geographies) { markError(geographiesEl); valid = false; } else clearError(geographiesEl);

    if (!leadsCountEl.value || isNaN(leadsCount) || leadsCount < 1 || leadsCount > 500) {
      markError(leadsCountEl); valid = false;
    } else {
      clearError(leadsCountEl);
    }

    if (employees.length === 0) {
      document.getElementById('intake-employees').style.outline = '2px solid var(--red)';
      document.getElementById('intake-employees').style.borderRadius = '8px';
      valid = false;
    } else {
      document.getElementById('intake-employees').style.outline = '';
    }

    if (revenue.length === 0) {
      document.getElementById('intake-revenue').style.outline = '2px solid var(--red)';
      document.getElementById('intake-revenue').style.borderRadius = '8px';
      valid = false;
    } else {
      document.getElementById('intake-revenue').style.outline = '';
    }

    if (!valid) {
      showStatus('intake', 'error', 'Please fill in all required fields before submitting.');
      return;
    }

    // Build payload
    const payload = {
      list_type: 'query',
      target_job_titles: jobTitles,
      target_industries: industries || null,
      target_geographies: geographies,
      keywords: keywords || null,
      leads_to_generate: leadsCount,
      number_of_employees: employees,
      annual_revenue_range: revenue,
      internal_context: context || null,
    };

    const btn = document.getElementById('btn-submit-intake');
    btn.disabled = true;
    showStatus('intake', 'loading', 'Sending your request...');

    try {
      const resp = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        // Hide form, show success screen
        form.style.display = 'none';
        successEl.classList.add('visible');
        hideStatus('intake');
      } else {
        btn.disabled = false;
        hideStatus('intake');
        showToast(`Data not sent — server responded with status ${resp.status}. Retry after some time.`);
      }
    } catch (err) {
      btn.disabled = false;
      hideStatus('intake');
      showToast('Data not sent. Please retry after some time.');
    }
  });

  // Reset form on "Submit Another Response"
  btnAgain.addEventListener('click', () => {
    form.reset();
    form.style.display = '';
    successEl.classList.remove('visible');
    document.getElementById('intake-employees').style.outline = '';
    document.getElementById('intake-revenue').style.outline = '';
    document.getElementById('btn-submit-intake').disabled = false;
    hideStatus('intake');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initUploads();
  initThemeToggle();
  initIntakeForm();
});

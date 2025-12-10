// script.js
// Uses pdf-lib (global PDFLib), Sortable (global Sortable), and DOMPurify loaded from CDN

// Configuration constants
const CONFIG = {
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB per file
  MAX_TOTAL_SIZE: 500 * 1024 * 1024, // 500MB total
  MAX_FILE_COUNT: 50, // Maximum 50 files
  LARGE_OUTPUT_THRESHOLD: 200, // Warn if output has >200 pages
};

const fileInput = document.getElementById('file-input');
const pickFilesBtn = document.getElementById('pick-files');
const dropZone = document.getElementById('drop-zone');
const fileListEl = document.getElementById('file-list');
const mergeBtn = document.getElementById('merge-btn');
const clearBtn = document.getElementById('clear-btn');
const progressEl = document.getElementById('progress');
const progressBar = document.getElementById('progress-bar');
const summaryEl = document.getElementById('summary');
const themeToggleBtn = document.getElementById('theme-toggle');
const toastContainer = document.getElementById('toast-container');

let filesArr = []; // { file:File, name, size, pageCount, id, hash }

function uid() { return Math.random().toString(36).slice(2,9); }

function updateButtons(){
  const has = filesArr.length > 0;
  mergeBtn.disabled = !has;
  clearBtn.disabled = !has;
  updateSummary();
}

function renderFileList(){
  fileListEl.innerHTML = '';
  filesArr.forEach((f,i) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.id = f.id;
    li.setAttribute('role', 'listitem');
    li.setAttribute('aria-label', `${f.name}, ${formatBytes(f.size)}, ${f.pageCount} pages`);

    li.innerHTML = `
      <div class="drag-handle" title="Drag to reorder" role="button" tabindex="0" aria-label="Drag to reorder ${escapeHtml(f.name)}">☰</div>
      <div class="file-meta">
        <div class="file-name">${escapeHtml(f.name)}</div>
        <div class="file-sub">${formatBytes(f.size)} — ${f.pageCount ?? '…'} pages</div>
      </div>
      <div class="file-actions">
        <button class="icon-btn remove" title="Remove ${escapeHtml(f.name)}" aria-label="Remove ${escapeHtml(f.name)}">✕</button>
      </div>
    `;
    fileListEl.appendChild(li);

    li.querySelector('.remove').addEventListener('click', () => {
      const removed = filesArr.find(x => x.id === f.id);
      if (removed && removed.rawBytes) {
        removed.rawBytes = null; // Free memory
      }
      filesArr = filesArr.filter(x => x.id !== f.id);
      renderFileList();
      updateButtons();
      showToast({ title: 'Removed', message: `${f.name} removed`, type: 'info', timeoutMs: 2000 });
    });
  });

  // attach Sortable
  if (window.Sortable) {
    if (fileListEl._sortable) fileListEl._sortable.destroy();
    fileListEl._sortable = Sortable.create(fileListEl, {
      handle: '.drag-handle',
      animation: 150,
      onEnd: (evt) => {
        const from = evt.oldIndex;
        const to = evt.newIndex;
        const moved = filesArr.splice(from,1)[0];
        filesArr.splice(to,0,moved);
        renderFileList(); // re-render to keep things stable
        updateSummary();
      }
    });
  }
}

// helpers
function escapeHtml(s){ 
  const text = String(s || '');
  return text
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#39;');
}
function sanitizeHtml(html) {
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html);
  }
  return escapeHtml(html);
}
function formatBytes(bytes){
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB','MB','GB','TB'];
  let i = -1;
  do { bytes = bytes / 1024; i++; } while (bytes >= 1024 && i < units.length-1);
  return bytes.toFixed(bytes < 10 ? 2:1) + ' ' + units[i];
}

async function hashFile(buffer) {
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function validateFile(file) {
  const errors = [];
  if (file.size > CONFIG.MAX_FILE_SIZE) {
    errors.push(`File exceeds ${formatBytes(CONFIG.MAX_FILE_SIZE)} limit`);
  }
  if (file.size === 0) {
    errors.push('File is empty');
  }
  return errors;
}

function getTotalSize() {
  return filesArr.reduce((sum, f) => sum + f.size, 0);
}

// file handling
pickFilesBtn.addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', async (e) => {
  await handleFiles(Array.from(e.target.files));
  fileInput.value = '';
});

['dragenter','dragover'].forEach(ev => {
  dropZone.addEventListener(ev, (e)=>{
    e.preventDefault();
    dropZone.style.outline = '2px solid rgba(110,231,183,0.14)';
  });
});
['dragleave','drop'].forEach(ev => {
  dropZone.addEventListener(ev, (e)=>{
    e.preventDefault();
    dropZone.style.outline = 'none';
  });
});
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  const items = Array.from(dt.files || []);
  await handleFiles(items);
});

async function handleFiles(files){
  if (!files || files.length === 0) return;
  
  // filter PDFs - be lenient with type checking for drag-and-drop compatibility
  const pdfs = files.filter(f => {
    const name = f.name.toLowerCase();
    const hasPdfExtension = name.endsWith('.pdf');
    const hasPdfType = f.type === 'application/pdf' || f.type === '';
    return hasPdfExtension || (hasPdfType && f.type === 'application/pdf');
  });
  
  if (pdfs.length === 0) {
    showToast({ title: 'Unsupported files', message: 'Please add PDF files only.', type: 'error' });
    return;
  }

  // Check file count limit
  if (filesArr.length + pdfs.length > CONFIG.MAX_FILE_COUNT) {
    showToast({ 
      title: 'Too many files', 
      message: `Maximum ${CONFIG.MAX_FILE_COUNT} files allowed. You tried to add ${pdfs.length} more.`, 
      type: 'error' 
    });
    return;
  }

  let addedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // read each file, get page count using pdf-lib
  for (const file of pdfs) {
    try {
      // Validate file
      const validationErrors = validateFile(file);
      if (validationErrors.length > 0) {
        showToast({ 
          title: 'Invalid file', 
          message: `${file.name}: ${validationErrors[0]}`, 
          type: 'error',
          timeoutMs: 3500
        });
        errorCount++;
        continue;
      }

      // Check total size limit
      if (getTotalSize() + file.size > CONFIG.MAX_TOTAL_SIZE) {
        showToast({ 
          title: 'Size limit exceeded', 
          message: `Total size would exceed ${formatBytes(CONFIG.MAX_TOTAL_SIZE)}`, 
          type: 'error' 
        });
        break;
      }

      const bytes = await file.arrayBuffer();
      const hash = await hashFile(bytes);
      
      // Better duplicate detection with hash
      const existing = filesArr.find(x => 
        (hash && x.hash === hash) || 
        (x.name === file.name && x.size === file.size)
      );
      if (existing) {
        skippedCount++;
        continue;
      }

      // Verify it's actually a PDF by checking magic number
      const header = new Uint8Array(bytes.slice(0, 5));
      const headerStr = String.fromCharCode.apply(null, Array.from(header));
      if (!headerStr.startsWith('%PDF-')) {
        console.error('Not a PDF file (invalid header):', file.name);
        showToast({ 
          title: 'Invalid file', 
          message: `${file.name} is not a valid PDF file`, 
          type: 'error',
          timeoutMs: 3500
        });
        errorCount++;
        continue;
      }

      const pdfDoc = await PDFLib.PDFDocument.load(bytes, { 
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
      const pages = pdfDoc.getPageCount();
      const id = uid();
      filesArr.push({ 
        file, 
        name: file.name, 
        size: file.size, 
        pageCount: pages, 
        id, 
        rawBytes: bytes,
        hash 
      });
      addedCount++;
    } catch (err) {
      console.error('Failed to process PDF', file.name, err);
      const errorMsg = err.message || String(err);
      let userMessage = 'Failed to process file';
      
      // Provide more specific error messages
      if (errorMsg.includes('encrypted')) {
        userMessage = 'File is encrypted or password protected';
      } else if (errorMsg.includes('Invalid') || errorMsg.includes('invalid')) {
        userMessage = 'Not a valid PDF file';
      } else if (errorMsg.includes('header')) {
        userMessage = 'File appears to be corrupted';
      } else if (errorMsg.includes('arrayBuffer')) {
        userMessage = 'Failed to read file data';
      }
      
      showToast({ 
        title: 'Cannot process file', 
        message: `${file.name}: ${userMessage}`, 
        type: 'error',
        timeoutMs: 4000
      });
      errorCount++;
    }
  }
  
  renderFileList();
  updateButtons();
  
  // Better feedback message
  if (addedCount > 0) {
    let msg = `${addedCount} file${addedCount>1?'s':''} added.`;
    if (skippedCount > 0) msg += ` ${skippedCount} duplicate${skippedCount>1?'s':''} skipped.`;
    showToast({ title: 'Files added', message: msg, type: 'success' });
  } else if (skippedCount > 0) {
    showToast({ title: 'No new files', message: `All ${skippedCount} file${skippedCount>1?'s were':' was'} already added.`, type: 'info' });
  }
}

// Merge logic
mergeBtn.addEventListener('click', async () => {
  if (filesArr.length === 0) return;
  
  const totalPages = filesArr.reduce((s,f) => s + (f.pageCount||0), 0);
  
  // Warn about large output
  if (totalPages > CONFIG.LARGE_OUTPUT_THRESHOLD) {
    const proceed = confirm(
      `Warning: The merged PDF will have ${totalPages} pages. ` +
      `This may take some time and result in a large file. Continue?`
    );
    if (!proceed) return;
  }
  
  let outPdf = null;
  try {
    mergeBtn.disabled = true;
    clearBtn.disabled = true;
    mergeBtn.textContent = 'Merging...';
    progressBar.style.width = '0%';
    progressEl.style.visibility = 'visible';

    outPdf = await PDFLib.PDFDocument.create();
    let added = 0;

    for (const item of filesArr) {
      try {
        // Load source PDF
        const src = await PDFLib.PDFDocument.load(item.rawBytes, { 
          ignoreEncryption: true,
          updateMetadata: false,
          throwOnInvalidObject: false
        });
        const srcPages = await outPdf.copyPages(src, src.getPageIndices());
        srcPages.forEach(p => outPdf.addPage(p));
        added += item.pageCount || srcPages.length;
        progressBar.style.width = Math.round((added/Math.max(1,totalPages))*100) + '%';
        await new Promise(r => setTimeout(r, 60)); // allow UI update for visible progress
      } catch (itemErr) {
        console.error('Error processing', item.name, itemErr);
        showToast({ 
          title: 'Partial failure', 
          message: `Skipped ${item.name} due to error`, 
          type: 'error',
          timeoutMs: 3500
        });
      }
    }

    if (added === 0) {
      throw new Error('No pages were successfully merged');
    }

    const mergedBytes = await outPdf.save();
    const blob = new Blob([mergedBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const filename = `merged-${timestamp}.pdf`;

    // create an anchor and download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // free
    URL.revokeObjectURL(url);
    progressBar.style.width = '100%';
    
    showToast({ 
      title: 'Success!', 
      message: `Merged ${added} pages into ${filename}`, 
      type: 'success',
      timeoutMs: 4000
    });
    
    // Clean up memory after successful merge
    cleanupMemory();
  } catch (err) {
    console.error(err);
    const errorMsg = err.message || String(err);
    showToast({ 
      title: 'Merge failed', 
      message: errorMsg.length > 100 ? errorMsg.substring(0, 97) + '...' : errorMsg, 
      type: 'error',
      timeoutMs: 5000
    });
  } finally {
    mergeBtn.disabled = false;
    clearBtn.disabled = false;
    mergeBtn.textContent = 'Merge PDFs';
    setTimeout(()=>{ 
      progressBar.style.width = '0%';
      progressEl.style.visibility = 'hidden';
    }, 750);
    // Cleanup
    outPdf = null;
  }
});

// Memory cleanup function
function cleanupMemory() {
  filesArr.forEach(item => {
    if (item.rawBytes) {
      item.rawBytes = null;
    }
  });
  if (typeof gc !== 'undefined') {
    gc(); // Suggest garbage collection if available
  }
}

clearBtn.addEventListener('click', () => {
  if (filesArr.length === 0) return;
  const previousFiles = filesArr.slice();
  cleanupMemory();
  filesArr = [];
  renderFileList();
  updateButtons();
  showToast({
    title: 'Cleared',
    message: 'All files removed.',
    type: 'success',
    actionLabel: 'Undo',
    onAction: () => {
      filesArr = previousFiles;
      renderFileList();
      updateButtons();
      showToast({ title: 'Restored', message: 'Files restored.', type: 'success' });
    }
  });
});

// init
renderFileList();
updateButtons();

// --- UX helpers ---
function updateSummary(){
  if (!summaryEl) return;
  const fileCount = filesArr.length;
  const pages = filesArr.reduce((s,f)=> s + (f.pageCount || 0), 0);
  if (fileCount === 0) {
    summaryEl.textContent = '';
  } else {
    summaryEl.textContent = `${fileCount} file${fileCount>1?'s':''} • ${pages} page${pages!==1?'s':''}`;
  }
}

// Drag highlight and keyboard accessibility
['dragenter','dragover'].forEach(ev => {
  dropZone.addEventListener(ev, (e)=>{
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
});
['dragleave','drop'].forEach(ev => {
  dropZone.addEventListener(ev, (e)=>{
    e.preventDefault();
    dropZone.classList.remove('dragging');
  });
});

dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

// Theme toggle with persistence
const PREF_KEY = 'pf-theme';
function applyTheme(theme){
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}
function initTheme(){
  const saved = localStorage.getItem(PREF_KEY);
  if (saved) {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}
initTheme();

if (themeToggleBtn){
  themeToggleBtn.addEventListener('click', ()=>{
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem(PREF_KEY, isDark ? 'dark' : 'light');
  });
}

// Toasts
function showToast({ title, message, type = 'success', timeoutMs = 2500, actionLabel, onAction }){
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'polite');
  
  const safeTitle = sanitizeHtml(title || '');
  const safeMessage = message ? sanitizeHtml(message) : '';
  const safeActionLabel = actionLabel ? sanitizeHtml(actionLabel) : '';
  
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${safeTitle}</div>
      ${safeMessage ? `<div class="toast-msg">${safeMessage}</div>` : ''}
    </div>
    ${safeActionLabel ? `<div class="toast-actions"><button class="toast-action">${safeActionLabel}</button></div>` : ''}
  `;
  toastContainer.appendChild(toast);
  const remove = () => {
    if (!toast.parentElement) return;
    toast.parentElement.removeChild(toast);
  };
  const timeoutId = setTimeout(remove, timeoutMs);
  if (actionLabel && onAction) {
    const btn = toast.querySelector('.toast-action');
    if (btn) {
      btn.addEventListener('click', () => {
        clearTimeout(timeoutId);
        remove();
        try { onAction(); } catch (e) { /* noop */ }
      });
    }
  }
}

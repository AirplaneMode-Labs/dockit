// The dockit pdf worker script (D5-05 stage 3). It is started by runtime startModuleWorker (a blob bootstrap that
// statically imports this file, inheriting the page CSP) with the 'dockit-workers' Trusted Types policy, and handed to
// pdf.js as PDFWorker.fromPort. The pdf.js worker module sets up its message handler on this global scope when it is
// evaluated. Nothing here touches the DOM or the network except through the guard installed first.
import './egress-first.ts';
import 'pdfjs-dist/build/pdf.worker.mjs';

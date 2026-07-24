/* ============================================================
   image-analyzer.js — 손도면 이미지 분석 + 사용자 입력 모듈
   
   v6: 실제 이미지 분석 지원
   
   기능:
   1. Canvas API로 이미지 가장자리 검출 (기본 형상 추정)
   2. 사용자 입력 다이얼로그로 정확한 치수 입력
   3. signals 형식으로 변환하여 기존 파이프라인 활용
   ============================================================ */

const ImageAnalyzer = (() => {

  /**
   * 이미지를 Canvas에 로드하여 기본 분석 수행
   * @param {File} file - 업로드된 이미지 파일
   * @returns {Promise<Object>} - 추정된 형상 데이터
   */
  async function analyzeImageBasic(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.onload = () => {
          try {
            const result = processImage(img);
            resolve(result);
          } catch (err) {
            resolve({ sections: [], totalLength: null, error: err.message });
          }
        };
        img.onerror = () => resolve({ sections: [], totalLength: null, error: 'Image load failed' });
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Canvas 기반 이미지 처리 — 수평 프로파일 추출
   */
  function processImage(img) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // 분석용 해상도로 리사이즈
    const maxW = 800;
    const scale = Math.min(1, maxW / img.width);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const w = canvas.width;
    const h = canvas.height;

    // 그레이스케일 변환 + 이진화
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }

    // Otsu threshold
    const threshold = otsuThreshold(gray);
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      binary[i] = gray[i] < threshold ? 1 : 0;
    }

    // 수평 프로젝션 (각 행의 검은 픽셀 수)
    const hProj = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (binary[y * w + x]) hProj[y]++;
      }
    }

    // 수직 프로젝션 (각 열의 검은 픽셀 수)
    const vProj = new Array(w).fill(0);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (binary[y * w + x]) vProj[x]++;
      }
    }

    // 주요 수평선 영역 찾기 (축 윤곽)
    const hPeaks = findPeaks(hProj, w * 0.1);
    
    // 수직 변화 지점 찾기 (단차 경계)
    const vChanges = findVerticalChanges(binary, w, h, hPeaks);

    console.log('[ImageAnalyzer] Horizontal peaks:', hPeaks.length);
    console.log('[ImageAnalyzer] Vertical changes:', vChanges.length);

    // 추정 결과
    const estimatedSections = Math.max(1, vChanges.length + 1);

    return {
      width: canvas.width,
      height: canvas.height,
      hPeaks,
      vChanges,
      estimatedSectionCount: estimatedSections,
      threshold,
    };
  }

  /**
   * Otsu threshold 계산
   */
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    
    let sumB = 0, wB = 0, wF = 0;
    let maxVar = 0, threshold = 0;
    
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;
      
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const variance = wB * wF * (mB - mF) * (mB - mF);
      
      if (variance > maxVar) {
        maxVar = variance;
        threshold = t;
      }
    }
    return threshold;
  }

  /**
   * 수평 프로젝션에서 피크 찾기
   */
  function findPeaks(proj, minValue) {
    const peaks = [];
    let inPeak = false;
    let start = 0;
    
    for (let i = 0; i < proj.length; i++) {
      if (proj[i] > minValue) {
        if (!inPeak) { start = i; inPeak = true; }
      } else {
        if (inPeak) {
          peaks.push({ start, end: i - 1, value: Math.max(...proj.slice(start, i)) });
          inPeak = false;
        }
      }
    }
    if (inPeak) peaks.push({ start, end: proj.length - 1, value: Math.max(...proj.slice(start)) });
    return peaks;
  }

  /**
   * 수직 변화 지점 찾기
   */
  function findVerticalChanges(binary, w, h, hPeaks) {
    if (hPeaks.length < 2) return [];
    
    // 축의 상/하 경계 추정
    const topY = hPeaks[0]?.start || Math.round(h * 0.3);
    const botY = hPeaks[hPeaks.length - 1]?.end || Math.round(h * 0.7);
    
    // 각 열에서 상/하 경계의 인크 밀도 변화 감지
    const colDensity = [];
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let y = topY; y <= botY; y++) {
        if (binary[y * w + x]) count++;
      }
      colDensity.push(count);
    }
    
    // 밀도 변화가 큰 지점 = 단차 경계
    const changes = [];
    const smoothed = movingAverage(colDensity, 5);
    
    for (let x = 10; x < w - 10; x++) {
      const diff = Math.abs(smoothed[x + 3] - smoothed[x - 3]);
      if (diff > (botY - topY) * 0.15) {
        // 최소 간격 유지
        if (changes.length === 0 || x - changes[changes.length - 1] > 15) {
          changes.push(x);
        }
      }
    }
    
    return changes;
  }

  /**
   * 이동 평균
   */
  function movingAverage(arr, window) {
    const result = new Array(arr.length).fill(0);
    const half = Math.floor(window / 2);
    for (let i = 0; i < arr.length; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
        sum += arr[j];
        count++;
      }
      result[i] = sum / count;
    }
    return result;
  }


  // ============================================================
  // ★ 사용자 입력 다이얼로그
  //
  // 이미지 분석 결과를 기반으로 사용자에게 확인/수정 요청
  // ============================================================

  /**
   * 대화형 shaft 파라미터 입력 다이얼로그 표시
   * @param {File} file - 업로드된 이미지
   * @param {Object} basicAnalysis - 기본 분석 결과 (추정 section 수 등)
   * @returns {Promise<Object>} - 사용자가 입력한 signals 데이터
   */
  /**
   * @param {File|null} file - 업로드된 이미지 (편집모드에서는 null)
   * @param {Object} basicAnalysis - 기본 분석 결과
   * @param {Object} [prefillData] - spec → signals 역변환 데이터 (파라미터 수정용)
   */
  function showParameterDialog(file, basicAnalysis, prefillData) {
    return new Promise((resolve, reject) => {
      // 기존 다이얼로그 제거
      const existing = document.getElementById('shaftParamDialog');
      if (existing) existing.remove();

      // CSS keyframes 주입 (한 번만)
      if (!document.getElementById('bearingSnapAnimStyle')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'bearingSnapAnimStyle';
        styleEl.textContent = `
          @keyframes fadeInUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
        `;
        document.head.appendChild(styleEl);
      }

      const overlay = document.createElement('div');
      overlay.id = 'shaftParamDialog';
      overlay.style.cssText = `
        position:fixed; top:0; left:0; width:100%; height:100%;
        background:rgba(0,0,0,0.92); z-index:10000;
        display:flex; align-items:center; justify-content:center;
        font-family: 'Noto Sans KR', sans-serif;
      `;

      const isEditMode = !!prefillData;
      const estimatedCount = prefillData?._sectionCount || basicAnalysis?.estimatedSectionCount || 3;
      const defaultCount = Math.min(Math.max(estimatedCount, 2), 12);

      overlay.innerHTML = `
        <div style="
          background:#1a1d27; border-radius:16px; padding:28px; width:90%; max-width:900px;
          max-height:85vh; overflow-y:auto; color:#e2e8f0; box-shadow:0 25px 50px rgba(0,0,0,0.5);
          border:1px solid rgba(255,255,255,0.1);
        ">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <h2 style="margin:0; font-size:20px; color:${isEditMode ? '#fbbf24' : '#93c5fd'};">
              ${isEditMode ? '✏️ 파라미터 수정' : '📐 축 형상 파라미터 입력'}
            </h2>
            <span style="font-size:12px; color:#94a3b8;">
              ${isEditMode ? '기존 값을 수정 후 도면을 다시 생성합니다' : `이미지 분석 추정: ${estimatedCount}개 구간`}
            </span>
          </div>

          <!-- ============ 스텝 인디케이터 ============ -->
          <div id="wizStepIndicator" style="display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:18px;">
            <div id="wizInd1" style="display:flex; align-items:center; gap:6px; padding:6px 16px; border-radius:20px; background:#1e3a5f; border:1px solid #3b82f6;">
              <span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:#3b82f6; color:white; font-size:12px; font-weight:700;">1</span>
              <span style="font-size:12px; color:#93c5fd; font-weight:600;">구간별 치수</span>
            </div>
            <div style="width:30px; height:2px; background:#3b3f51;"></div>
            <div id="wizInd2" style="display:flex; align-items:center; gap:6px; padding:6px 16px; border-radius:20px; background:#242836; border:1px solid #3b3f51;">
              <span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:#3b3f51; color:#6b7280; font-size:12px; font-weight:700;">2</span>
              <span style="font-size:12px; color:#6b7280; font-weight:600;">부가 정보</span>
            </div>
          </div>

          <!-- ============ STEP 1: 구간별 치수 ============ -->
          <div id="wizStep1">

          <!-- 이미지 미리보기 (편집모드에서는 숨김) -->
          <div id="paramPreviewWrap" style="margin-bottom:16px; text-align:center; ${isEditMode ? 'display:none;' : ''}">
            <img id="paramDialogPreview" style="max-width:100%; max-height:150px; border-radius:8px; border:1px solid #333;" />
          </div>

          <!-- 축 유형 선택 (중실축 / 중공축) -->
          <div style="margin-bottom:16px;">
            <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:6px;">축 유형</label>
            <div style="display:flex; gap:8px;">
              <button id="btnShaftSolid" type="button" style="
                flex:1; padding:10px 16px; border-radius:8px; font-size:13px; font-weight:600;
                cursor:pointer; transition:all 0.2s;
                background:#3b82f6; color:white; border:2px solid #3b82f6;
              ">🔵 중실축 (Solid)</button>
              <button id="btnShaftHollow" type="button" style="
                flex:1; padding:10px 16px; border-radius:8px; font-size:13px; font-weight:600;
                cursor:pointer; transition:all 0.2s;
                background:transparent; color:#94a3b8; border:2px solid #3b3f51;
              ">⭕ 중공축 (Hollow)</button>
            </div>
            <input type="hidden" id="paramShaftType" value="solid">
          </div>

          <!-- 기본 정보 -->
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:12px; margin-bottom:16px;">
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">구간 수</label>
              <input type="number" id="paramSectionCount" value="${defaultCount}" min="1" max="20"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">전체 길이 (mm)</label>
              <input type="number" id="paramTotalLength" placeholder="선택사항"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">재질</label>
              <input type="text" id="paramMaterial" placeholder="예: S45C"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#f472b6; display:block; margin-bottom:4px;">용지 크기</label>
              <select id="paramPaperSize"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
                <option value="A3" selected>A3</option>
                <option value="A4">A4</option>
              </select>
            </div>
          </div>

          <!-- 품명 / 척도 / 각법 -->
          <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:12px; margin-bottom:16px;">
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">품명</label>
              <input type="text" id="paramPartName" placeholder="예: 단축 A"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">척도 (A:B)</label>
              <input type="text" id="paramScale" value="1:1" placeholder="1:1"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
              <div style="font-size:9px; color:#6b7280; margin-top:2px;">A = 도면크기, B = 실물크기</div>
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">각법</label>
              <select id="paramProjection" style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
                <option value="3각법" selected>3각법</option>
                <option value="1각법">1각법</option>
              </select>
            </div>
          </div>

          <!-- 구간별 상세 입력 -->
          <div style="margin-bottom:16px;">
            <h3 style="font-size:14px; color:#93c5fd; margin:0 0 8px;">
              구간별 치수 (좌→우)
            </h3>
            <div id="sectionInputs" style="display:grid; gap:8px;"></div>
          </div>

          <!-- Step 1 버튼 -->
          <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
            <button id="paramBtnCancelStep1" style="
              padding:10px 20px; background:#374151; border:none; border-radius:8px;
              color:#e2e8f0; cursor:pointer; font-size:14px;
            ">취소</button>
            <button id="paramBtnNext" style="
              padding:10px 24px; background:linear-gradient(135deg,#3b82f6,#6366f1);
              border:none; border-radius:8px; color:white; cursor:pointer; font-size:14px; font-weight:600;
            ">다음 →</button>
          </div>

          </div><!-- /wizStep1 -->

          <!-- ============ STEP 2: 부가 정보 ============ -->
          <div id="wizStep2" style="display:none;">

          <!-- 부가 정보 -->
          <div style="margin-bottom:16px;">
            <h3 style="font-size:14px; color:#93c5fd; margin:0 0 8px;">
              부가 정보 (선택)
            </h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <!-- ===== 좌측 TAP ===== -->
              <div>
                <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">
                  좌측 TAP
                </label>
                <!-- 나사 종류 선택 -->
                <div style="display:flex; gap:4px; margin-bottom:4px;">
                  <select id="paramLeftTapType"
                    style="flex:1; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:11px;">
                    <option value="">종류 선택</option>
                    <option value="coarse">보통나사 (KS B 0201)</option>
                    <option value="fine">가는나사 (KS B 0204)</option>
                  </select>
                </div>
                <!-- M 사이즈 + 깊이 -->
                <div style="display:flex; gap:4px; margin-bottom:4px;">
                  <input type="text" id="paramLeftTap" placeholder="M20"
                    style="flex:1; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <input type="number" id="paramLeftTapDepth" placeholder="깊이"
                    style="width:60px; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
                <!-- 피치 선택 -->
                <div style="display:flex; gap:4px; align-items:center; margin-bottom:4px;">
                  <label style="font-size:10px; color:#fbbf24; white-space:nowrap;">피치</label>
                  <select id="paramLeftTapPitch"
                    style="flex:1; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:11px;">
                    <option value="">종류/사이즈 선택 필요</option>
                  </select>
                  <span id="paramLeftTapPitchLabel" style="font-size:10px; color:#6b7280; white-space:nowrap;"></span>
                </div>
                <!-- 좌측 카운터보어 -->
                <div style="margin-top:2px;">
                  <label style="font-size:10px; color:#a78bfa; cursor:pointer;">
                    <input type="checkbox" id="paramLeftCB" style="margin-right:4px;"> C/B (카운터보어)
                  </label>
                  <div id="paramLeftCBInputs" style="display:none; margin-top:4px; display:none; gap:4px;">
                    <div style="display:flex; gap:4px;">
                      <input type="number" id="paramLeftCBDiam" placeholder="C/B 직경" step="0.1"
                        style="flex:1; padding:4px; background:#242836; border:1px solid #5b21b6; border-radius:4px; color:#c4b5fd; font-size:11px;">
                      <input type="number" id="paramLeftCBDepth" placeholder="C/B 깊이" step="0.1"
                        style="flex:1; padding:4px; background:#242836; border:1px solid #5b21b6; border-radius:4px; color:#c4b5fd; font-size:11px;">
                    </div>
                  </div>
                </div>
              </div>
              <!-- ===== 우측 TAP ===== -->
              <div>
                <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">
                  우측 TAP
                </label>
                <!-- 나사 종류 선택 -->
                <div style="display:flex; gap:4px; margin-bottom:4px;">
                  <select id="paramRightTapType"
                    style="flex:1; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:11px;">
                    <option value="">종류 선택</option>
                    <option value="coarse">보통나사 (KS B 0201)</option>
                    <option value="fine">가는나사 (KS B 0204)</option>
                  </select>
                </div>
                <!-- M 사이즈 + 깊이 -->
                <div style="display:flex; gap:4px; margin-bottom:4px;">
                  <input type="text" id="paramRightTap" placeholder="M10"
                    style="flex:1; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <input type="number" id="paramRightTapDepth" placeholder="깊이"
                    style="width:60px; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
                <!-- 피치 선택 -->
                <div style="display:flex; gap:4px; align-items:center; margin-bottom:4px;">
                  <label style="font-size:10px; color:#fbbf24; white-space:nowrap;">피치</label>
                  <select id="paramRightTapPitch"
                    style="flex:1; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:11px;">
                    <option value="">종류/사이즈 선택 필요</option>
                  </select>
                  <span id="paramRightTapPitchLabel" style="font-size:10px; color:#6b7280; white-space:nowrap;"></span>
                </div>
                <!-- 우측 카운터보어 -->
                <div style="margin-top:2px;">
                  <label style="font-size:10px; color:#a78bfa; cursor:pointer;">
                    <input type="checkbox" id="paramRightCB" style="margin-right:4px;"> C/B (카운터보어)
                  </label>
                  <div id="paramRightCBInputs" style="display:none; margin-top:4px; gap:4px;">
                    <div style="display:flex; gap:4px;">
                      <input type="number" id="paramRightCBDiam" placeholder="C/B 직경" step="0.1"
                        style="flex:1; padding:4px; background:#242836; border:1px solid #5b21b6; border-radius:4px; color:#c4b5fd; font-size:11px;">
                      <input type="number" id="paramRightCBDepth" placeholder="C/B 깊이" step="0.1"
                        style="flex:1; padding:4px; background:#242836; border:1px solid #5b21b6; border-radius:4px; color:#c4b5fd; font-size:11px;">
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 키홈 갯수 선택 + 동적 입력 -->
            <div style="margin-top:8px; display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#93c5fd; font-weight:600;">키홈 수</label>
              <input type="number" id="paramKeywayCount" value="0" min="0" max="10"
                style="width:60px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px; text-align:center;">
              <span style="font-size:10px; color:#6b7280;">0 = 키홈 없음</span>
            </div>
            <div id="keywayInputs" style="display:grid; gap:8px;"></div>

            <!-- 관통 구멍 갯수 선택 + 동적 입력 -->
            <div style="margin-top:12px; display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#34d399; font-weight:600;">관통 구멍 수</label>
              <input type="number" id="paramThroughHoleCount" value="0" min="0" max="10"
                style="width:60px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px; text-align:center;">
              <span style="font-size:10px; color:#6b7280;">0 = 관통 구멍 없음</span>
            </div>
            <div id="throughHoleInputs" style="display:grid; gap:8px;"></div>

            <!-- 스냅링 갯수 선택 + 동적 입력 -->
            <div style="margin-top:12px; display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#f472b6; font-weight:600;">스냅링 수</label>
              <input type="number" id="paramSnapRingCount" value="0" min="0" max="10"
                style="width:60px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px; text-align:center;">
              <span style="font-size:10px; color:#6b7280;">0 = 스냅링 없음</span>
            </div>
            <div id="snapRingInputs" style="display:grid; gap:8px;"></div>

            <!-- 체인스프라켓(스프라켓) 갯수 선택 + 동적 입력 -->
            <div style="margin-top:12px; display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#fb923c; font-weight:600;">⚙ 체인스프라켓 수</label>
              <input type="number" id="paramChainGearCount" value="0" min="0" max="2"
                style="width:60px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px; text-align:center;">
              <span style="font-size:10px; color:#6b7280;">0 = 없음, 최대 2</span>
            </div>
            <div id="chainGearInputs" style="display:grid; gap:8px;"></div>

            <!-- 베어링(깊은 홈 볼베어링) 갯수 선택 + 동적 입력 -->
            <div style="margin-top:12px; display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#38bdf8; font-weight:600;">◎ 베어링 수</label>
              <input type="number" id="paramBearingCount" value="0" min="0" max="4" readonly
                style="width:60px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#6b7280; font-size:13px; text-align:center; cursor:not-allowed;"
                title="스냅링을 먼저 입력하세요">
              <span style="font-size:10px; color:#6b7280;">스냅링 연동 — 자동 설정</span>
            </div>
            <div id="bearingInputs" style="display:grid; gap:8px;"></div>
            <!-- 베어링 경고 토스트 (우측 하단) -->
            <div id="bearingSnapWarnToast" style="display:none; position:fixed; bottom:24px; right:24px; z-index:99999;
              background:#2a1215; border:1px solid #b91c1c; border-radius:10px; padding:12px 20px;
              box-shadow:0 4px 24px rgba(0,0,0,0.5); font-size:13px; color:#fca5a5; font-weight:600;
              animation: fadeInUp .3s ease;">
              ⚠ 스냅링 값을 입력해주세요
            </div>
          </div>

          <!-- 중공축 보조투상도 설정 (중공축 선택 시에만 표시) -->
          <div id="hollowShaftSection" style="display:none; margin-bottom:16px;">
            <div style="background:#1e2230; border:1px solid #f59e0b; border-radius:8px; padding:12px;">
              <h3 style="font-size:14px; color:#f59e0b; margin:0 0 8px;">
                ⭕ 축 보조투상도 (중공축 단면)
              </h3>
              <p style="font-size:11px; color:#94a3b8; margin:0 0 10px;">
                중공축의 끝단 보조투상도에 표시할 내경을 입력하세요.<br>
                가장 끝 구간의 우측에 외경(구간 직경)과 내경(빈 공간)을 동심원으로 표시합니다.
              </p>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                  <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">내경 (mm) — 중공 직경</label>
                  <input type="number" id="paramHollowBoreDiam" placeholder="예: 10" min="1"
                    style="width:100%; padding:7px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:13px;">
                </div>
                <div>
                  <label style="font-size:10px; color:#94a3b8; display:block; margin-bottom:2px;">외경 (자동: 끝 구간 직경)</label>
                  <input type="text" id="paramHollowOuterDiam" placeholder="자동 계산" disabled
                    style="width:100%; padding:7px; background:#1a1d27; border:1px solid #3b3f51; border-radius:6px; color:#6b7280; font-size:13px;">
                </div>
              </div>
            </div>
          </div>

          <!-- Step 2 버튼 -->
          <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
            <button id="paramBtnPrev" style="
              padding:10px 20px; background:#374151; border:none; border-radius:8px;
              color:#e2e8f0; cursor:pointer; font-size:14px;
            ">← 이전</button>
            <button id="paramBtnCancel" style="
              padding:10px 20px; background:#374151; border:none; border-radius:8px;
              color:#e2e8f0; cursor:pointer; font-size:14px;
            ">취소</button>
            <button id="paramBtnGenerate" style="
              padding:10px 24px; background:linear-gradient(135deg,#3b82f6,#6366f1);
              border:none; border-radius:8px; color:white; cursor:pointer; font-size:14px; font-weight:600;
            ">도면 생성</button>
          </div>

          </div><!-- /wizStep2 -->
        </div>
      `;

      document.body.appendChild(overlay);

      // 이미지 미리보기 (편집모드에서는 스킵)
      if (file && !isEditMode) {
        const preview = document.getElementById('paramDialogPreview');
        const fileReader = new FileReader();
        fileReader.onload = (e) => { preview.src = e.target.result; };
        fileReader.readAsDataURL(file);
      }

      // ── 축 유형 버튼 토글 ──
      const btnSolid = document.getElementById('btnShaftSolid');
      const btnHollow = document.getElementById('btnShaftHollow');
      const shaftTypeInput = document.getElementById('paramShaftType');
      const hollowSection = document.getElementById('hollowShaftSection');

      btnSolid.addEventListener('click', () => {
        shaftTypeInput.value = 'solid';
        btnSolid.style.background = '#3b82f6';
        btnSolid.style.color = 'white';
        btnSolid.style.borderColor = '#3b82f6';
        btnHollow.style.background = 'transparent';
        btnHollow.style.color = '#94a3b8';
        btnHollow.style.borderColor = '#3b3f51';
        hollowSection.style.display = 'none';
      });

      btnHollow.addEventListener('click', () => {
        shaftTypeInput.value = 'hollow';
        btnHollow.style.background = '#f59e0b';
        btnHollow.style.color = '#1a1d27';
        btnHollow.style.borderColor = '#f59e0b';
        btnSolid.style.background = 'transparent';
        btnSolid.style.color = '#94a3b8';
        btnSolid.style.borderColor = '#3b3f51';
        hollowSection.style.display = 'block';
      });

      // 중공축 외경 자동 표시 업데이트 함수
      function updateHollowOuterDiam() {
        const outerDiamEl = document.getElementById('paramHollowOuterDiam');
        if (!outerDiamEl) return;
        const count = parseInt(document.getElementById('paramSectionCount').value) || 0;
        if (count <= 0) { outerDiamEl.value = ''; return; }
        const lastDiamEl = document.querySelector(`.sec-diameter[data-idx="${count - 1}"]`);
        if (lastDiamEl && lastDiamEl.value) {
          outerDiamEl.value = `⌀${lastDiamEl.value} (S${count})`;
        } else {
          outerDiamEl.value = '끝 구간 직경 미입력';
        }
      }

      // 구간 입력 필드 생성
      const countInput = document.getElementById('paramSectionCount');
      const sectionInputsDiv = document.getElementById('sectionInputs');

      // ★ keywayInputsDiv, snapRingInputsDiv, throughHoleInputsDiv를 buildSectionInputs보다 먼저 선언 (TDZ 방지)
      const keywayCountInput = document.getElementById('paramKeywayCount');
      const keywayInputsDiv = document.getElementById('keywayInputs');
      const snapRingCountInput = document.getElementById('paramSnapRingCount');
      const snapRingInputsDiv = document.getElementById('snapRingInputs');
      const throughHoleCountInput = document.getElementById('paramThroughHoleCount');
      const throughHoleInputsDiv = document.getElementById('throughHoleInputs');
      const chainGearCountInput = document.getElementById('paramChainGearCount');
      const chainGearInputsDiv = document.getElementById('chainGearInputs');
      const bearingCountInput = document.getElementById('paramBearingCount');
      const bearingInputsDiv = document.getElementById('bearingInputs');

      // ★ 카운터보어 체크박스 토글
      const leftCBCheck = document.getElementById('paramLeftCB');
      const leftCBInputs = document.getElementById('paramLeftCBInputs');
      const rightCBCheck = document.getElementById('paramRightCB');
      const rightCBInputs = document.getElementById('paramRightCBInputs');
      if (leftCBCheck && leftCBInputs) {
        leftCBCheck.addEventListener('change', () => {
          leftCBInputs.style.display = leftCBCheck.checked ? 'block' : 'none';
        });
      }
      if (rightCBCheck && rightCBInputs) {
        rightCBCheck.addEventListener('change', () => {
          rightCBInputs.style.display = rightCBCheck.checked ? 'block' : 'none';
        });
      }

      // ★ v176: 나사 피치 선택 기능 (KS B 0201 보통나사 / KS B 0204 가는나사)
      function _updateTapPitchOptions(side) {
        const typeEl = document.getElementById(`param${side}TapType`);
        const tapEl = document.getElementById(`param${side}Tap`);
        const pitchEl = document.getElementById(`param${side}TapPitch`);
        const labelEl = document.getElementById(`param${side}TapPitchLabel`);
        if (!typeEl || !tapEl || !pitchEl) return;

        const threadType = typeEl.value; // 'coarse' | 'fine' | ''
        const tapStr = tapEl.value.trim();
        const mSize = parseFloat(tapStr.replace(/[^0-9.]/g, ''));

        // 피치 셀렉트 초기화
        pitchEl.innerHTML = '';
        if (labelEl) labelEl.textContent = '';

        if (!threadType) {
          pitchEl.innerHTML = '<option value="">종류 선택 필요</option>';
          return;
        }
        if (!tapStr || isNaN(mSize)) {
          pitchEl.innerHTML = '<option value="">M 사이즈 입력 필요</option>';
          return;
        }

        const result = DrawingModel.lookupThreadPitch(threadType, mSize);
        if (!result.found) {
          pitchEl.innerHTML = `<option value="">M${mSize} — 해당 규격 없음</option>`;
          if (labelEl) labelEl.textContent = '⚠';
          return;
        }

        if (threadType === 'coarse') {
          // 보통나사: 피치 1개 고정
          const p = result.pitches[0];
          pitchEl.innerHTML = `<option value="${p}">${p}</option>`;
          pitchEl.style.color = '#34d399';
          if (labelEl) labelEl.textContent = '(고정)';
        } else {
          // 가는나사: 복수 피치 선택
          result.pitches.forEach((p, idx) => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            if (idx === 0) opt.selected = true;
            pitchEl.appendChild(opt);
          });
          pitchEl.style.color = '#fbbf24';
          if (labelEl) labelEl.textContent = `(${result.pitches.length}종)`;
        }
      }

      // 좌측/우측 TAP 이벤트 바인딩
      ['Left', 'Right'].forEach(side => {
        const typeEl = document.getElementById(`param${side}TapType`);
        const tapEl = document.getElementById(`param${side}Tap`);
        if (typeEl) {
          typeEl.addEventListener('change', () => _updateTapPitchOptions(side));
        }
        if (tapEl) {
          ['input', 'change'].forEach(evt => {
            tapEl.addEventListener(evt, () => _updateTapPitchOptions(side));
          });
        }
      });

      function buildSectionInputs(count) {
        sectionInputsDiv.innerHTML = '';
        
        // 헤더
        const header = document.createElement('div');
        header.style.cssText = 'display:grid; grid-template-columns:40px 1fr 1fr; gap:8px; font-size:11px; color:#94a3b8; padding:0 4px;';
        header.innerHTML = '<span>#</span><span>길이 (mm)</span><span>직경 (mm)</span>';
        sectionInputsDiv.appendChild(header);

        for (let i = 0; i < count; i++) {
          const row = document.createElement('div');
          row.style.cssText = 'display:grid; grid-template-columns:40px 1fr 1fr; gap:8px; align-items:center;';
          row.innerHTML = `
            <span style="font-size:12px; color:#93c5fd; font-weight:600;">S${i + 1}</span>
            <input type="number" class="sec-length" data-idx="${i}" placeholder="길이" min="1"
              style="padding:7px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px;">
            <input type="number" class="sec-diameter" data-idx="${i}" placeholder="직경" min="1"
              style="padding:7px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px;">
          `;
          sectionInputsDiv.appendChild(row);

          // ★ v114: 프로파일 타입 + 테이퍼 끝직경 행
          const profileRow = document.createElement('div');
          profileRow.style.cssText = 'display:grid; grid-template-columns:40px 1fr 1fr; gap:8px; align-items:center; margin-bottom:2px;';
          profileRow.innerHTML = `
            <span style="font-size:10px; color:#64748b;"></span>
            <select class="sec-profile" data-idx="${i}"
              style="padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#a78bfa; font-size:11px; cursor:pointer;">
              <option value="CYLINDER">원통 (CYLINDER)</option>
              <option value="TAPER">테이퍼 (TAPER)</option>
            </select>
            <input type="number" class="sec-diameter-end" data-idx="${i}" placeholder="우측 직경" min="1"
              style="padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#a78bfa; font-size:11px; display:none;">
          `;
          sectionInputsDiv.appendChild(profileRow);

          // 프로파일 선택 시 끝직경 입력 표시/숨김 + 라벨 변경
          const profileSel = profileRow.querySelector(`.sec-profile[data-idx="${i}"]`);
          const diamEndEl = profileRow.querySelector(`.sec-diameter-end[data-idx="${i}"]`);
          const diamStartEl = row.querySelector(`.sec-diameter[data-idx="${i}"]`);
          profileSel.addEventListener('change', function() {
            const isTaper = profileSel.value === 'TAPER';
            diamEndEl.style.display = isTaper ? 'inline-block' : 'none';
            diamStartEl.placeholder = isTaper ? '좌측 직경' : '직경';
          });

          // ★ v111: 모따기(chamfer) 옵션 행 — 좌측/우측 체크박스 + C값 입력
          const chamferRow = document.createElement('div');
          chamferRow.style.cssText = 'display:grid; grid-template-columns:40px 1fr 1fr; gap:8px; align-items:center; margin-bottom:4px;';
          chamferRow.innerHTML = `
            <span style="font-size:10px; color:#64748b;"></span>
            <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:#94a3b8; cursor:pointer;">
              <input type="checkbox" class="sec-chamfer-left" data-idx="${i}"
                style="width:14px; height:14px; accent-color:#f59e0b; cursor:pointer;">
              <span>좌 모따기</span>
              <input type="number" class="sec-chamfer-left-val" data-idx="${i}" placeholder="C" min="0.1" step="0.1"
                style="width:50px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#fbbf24; font-size:11px; display:none;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:#94a3b8; cursor:pointer;">
              <input type="checkbox" class="sec-chamfer-right" data-idx="${i}"
                style="width:14px; height:14px; accent-color:#f59e0b; cursor:pointer;">
              <span>우 모따기</span>
              <input type="number" class="sec-chamfer-right-val" data-idx="${i}" placeholder="C" min="0.1" step="0.1"
                style="width:50px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#fbbf24; font-size:11px; display:none;">
            </label>
          `;
          sectionInputsDiv.appendChild(chamferRow);

          // 체크박스 토글 시 C값 입력 표시/숨김
          const chkL = chamferRow.querySelector(`.sec-chamfer-left[data-idx="${i}"]`);
          const valL = chamferRow.querySelector(`.sec-chamfer-left-val[data-idx="${i}"]`);
          const chkR = chamferRow.querySelector(`.sec-chamfer-right[data-idx="${i}"]`);
          const valR = chamferRow.querySelector(`.sec-chamfer-right-val[data-idx="${i}"]`);
          chkL.addEventListener('change', function() { valL.style.display = chkL.checked ? 'inline-block' : 'none'; });
          chkR.addEventListener('change', function() { valR.style.display = chkR.checked ? 'inline-block' : 'none'; });
        }

        // 직경 변경 시 중공축 외경 자동 업데이트 + 스냅링/베어링/키홈 자동 규격 재계산
        sectionInputsDiv.querySelectorAll('.sec-diameter').forEach(el => {
          el.addEventListener('input', updateHollowOuterDiam);
          ['input', 'change'].forEach(evt => el.addEventListener(evt, () => {
            if (typeof refreshAllSnapRingBlocks === 'function') refreshAllSnapRingBlocks();
            if (typeof refreshAllBearingBlocks === 'function') refreshAllBearingBlocks();
            // v178: 직경 변경 시 키홈 KS 규격 재조회
            if (typeof refreshAllKeywayBlocks === 'function') refreshAllKeywayBlocks();
          }));
        });
        // 길이 변경 시 스냅링/베어링 우측 오프셋 자동 재계산
        sectionInputsDiv.querySelectorAll('.sec-length').forEach(el => {
          ['input', 'change'].forEach(evt => el.addEventListener(evt, () => {
            if (typeof refreshAllSnapRingBlocks === 'function') refreshAllSnapRingBlocks();
            if (typeof refreshAllBearingBlocks === 'function') refreshAllBearingBlocks();
          }));
        });

        // 중공축 외경 자동 표시 업데이트
        updateHollowOuterDiam();

        // 키홈 select 업데이트 (동적 키홈)
        updateKeywaySelects(count);
        // 스냅링 select 업데이트
        updateSnapRingSelects(count);
        // 관통 구멍 select 업데이트
        updateThroughHoleSelects(count);
        // 체인스프라켓 select 업데이트
        if (typeof updateChainGearSelects === 'function') updateChainGearSelects(count);
        // 베어링 select 업데이트
        if (typeof updateBearingSelects === 'function') updateBearingSelects(count);
      }

      buildSectionInputs(defaultCount);

      // ★ 구간 수 변경 — 모든 이벤트 유형 등록 (브라우저 호환성 보장)
      let _lastSecCount = defaultCount;
      function onSectionCountChange() {
        const n = Math.min(Math.max(parseInt(countInput.value) || 2, 1), 20);
        if (n === _lastSecCount) return;  // 중복 호출 방지
        _lastSecCount = n;
        countInput.value = n;
        buildSectionInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        countInput.addEventListener(evt, onSectionCountChange);
      });

      // ── 키홈 동적 입력 빌더 (v178: KS B 1311 자동 규격 조회) ──
      function buildKeywayInputs(kwCount) {
        keywayInputsDiv.innerHTML = '';
        const secCount = parseInt(countInput.value) || 0;

        for (let k = 0; k < kwCount; k++) {
          const block = document.createElement('div');
          block.style.cssText = 'background:#1e2230; border:1px solid #3b3f51; border-radius:8px; padding:12px;';
          
          // 구간 선택 옵션
          let secOptions = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            secOptions += `<option value="S${s + 1}">S${s + 1}</option>`;
          }

          block.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#93c5fd; font-weight:600;">키홈 ${k + 1}</label>
              <select class="kw-sec" data-kw-idx="${k}" style="width:60px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                ${secOptions}
              </select>
              <select class="kw-dir" data-kw-idx="${k}" style="width:70px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#a78bfa; font-size:11px; cursor:pointer;" title="키 방향: 정면(front) / 측면(side)">
                <option value="side">측면</option>
                <option value="front">정면</option>
              </select>
              <select class="kw-shape" data-kw-idx="${k}" style="padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#22d3ee; font-size:11px; cursor:pointer;">
                <option value="obround">양쪽 둥근형</option>
                <option value="one-side-round">한쪽 둥근형</option>
                <option value="rect">양쪽 네모형</option>
              </select>
            </div>
            <!-- v178: KS B 1311 자동 규격 표시 -->
            <div class="kw-ks-info" data-kw-idx="${k}" style="background:#242836; border:1px solid #2d4a2d; border-radius:6px; padding:6px 8px; margin-bottom:6px; font-size:11px; color:#6b7280;">
              구간을 선택하면 KS B 1311 규격이 자동 표시됩니다
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#34d399; display:block; margin-bottom:2px;">폭 b (mm) <span style="color:#6b7280;">KS</span></label>
                <input type="number" class="kw-w" data-kw-idx="${k}" placeholder="폭" readonly style="width:100%; padding:5px; background:#1a1e28; border:1px solid #2d4a2d; border-radius:6px; color:#34d399; font-size:12px; cursor:default;">
              </div>
              <div>
                <label style="font-size:10px; color:#34d399; display:block; margin-bottom:2px;">높이 h (mm) <span style="color:#6b7280;">KS</span></label>
                <input type="number" class="kw-h" data-kw-idx="${k}" placeholder="높이" readonly style="width:100%; padding:5px; background:#1a1e28; border:1px solid #2d4a2d; border-radius:6px; color:#34d399; font-size:12px; cursor:default;">
              </div>
              <div>
                <label style="font-size:10px; color:#34d399; display:block; margin-bottom:2px;">깊이 t1 (mm) <span style="color:#6b7280;">KS</span></label>
                <input type="number" class="kw-d" data-kw-idx="${k}" placeholder="깊이" readonly style="width:100%; padding:5px; background:#1a1e28; border:1px solid #2d4a2d; border-radius:6px; color:#34d399; font-size:12px; cursor:default;">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#e2e8f0; display:block; margin-bottom:2px;">길이 L (mm)</label>
                <input type="number" class="kw-len" data-kw-idx="${k}" placeholder="길이" min="1" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">좌측 이격 (mm)</label>
                <input type="number" class="kw-left-off" data-kw-idx="${k}" placeholder="좌측에서 거리" style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">우측 이격 <span style="color:#6b7280;">자동</span></label>
                <input type="number" class="kw-right-off" data-kw-idx="${k}" placeholder="자동" readonly style="width:100%; padding:5px; background:#1a1e28; border:1px solid #554a20; border-radius:6px; color:#34d399; font-size:12px; cursor:default;">
                <div class="kw-right-warn" data-kw-idx="${k}" style="display:none; font-size:10px; color:#f87171; margin-top:2px;">⚠ 구간 길이 초과</div>
              </div>
            </div>
            <div style="font-size:10px; color:#6b7280; margin-top:2px;">
              * KS B 1311 — 구간 축지름 기반 b×h, t1 자동 선택 / 우측 이격 = 구간길이 − (길이L + 좌측이격) 자동 계산
            </div>
          `;
          keywayInputsDiv.appendChild(block);

          // v178: 구간 선택 시 KS 규격 자동 조회
          const secSel = block.querySelector('.kw-sec');
          secSel?.addEventListener('change', () => _refreshKeywayKS(k));

          // 이벤트 바인딩: 좌측 이격·길이·구간 변경 시 우측 이격 자동 계산
          ['input', 'change'].forEach(evt => {
            block.querySelector('.kw-left-off')?.addEventListener(evt, () => _updateKeywayRightOffset(k));
            block.querySelector('.kw-len')?.addEventListener(evt, () => _updateKeywayRightOffset(k));
            block.querySelector('.kw-sec')?.addEventListener(evt, () => _updateKeywayRightOffset(k));
          });
        }
      }

      // v178: KS B 1311 키 규격 자동 조회 — 구간 축지름 → b, h, t1
      function _refreshKeywayKS(k) {
        const secVal = keywayInputsDiv.querySelector(`.kw-sec[data-kw-idx="${k}"]`)?.value || '';
        const infoEl = keywayInputsDiv.querySelector(`.kw-ks-info[data-kw-idx="${k}"]`);
        const wEl = keywayInputsDiv.querySelector(`.kw-w[data-kw-idx="${k}"]`);
        const hEl = keywayInputsDiv.querySelector(`.kw-h[data-kw-idx="${k}"]`);
        const dEl = keywayInputsDiv.querySelector(`.kw-d[data-kw-idx="${k}"]`);
        if (!infoEl || !wEl || !hEl || !dEl) return;

        if (!secVal) {
          infoEl.textContent = '구간을 선택하면 KS B 1311 규격이 자동 표시됩니다';
          infoEl.style.borderColor = '#2d4a2d';
          infoEl.style.color = '#6b7280';
          wEl.value = ''; hEl.value = ''; dEl.value = '';
          return;
        }

        const { diam } = _getSectionDims(secVal);
        if (isNaN(diam)) {
          infoEl.innerHTML = `<span style="color:#f87171;">⚠ ${secVal} 직경 미입력</span>`;
          infoEl.style.borderColor = '#7f1d1d';
          wEl.value = ''; hEl.value = ''; dEl.value = '';
          return;
        }

        const result = DrawingModel.lookupKeyByShaftDiam(diam);
        if (!result.found) {
          infoEl.innerHTML = `<span style="color:#f87171;">⚠ Ø${diam} — KS B 1311 범위 밖 (${result.reason === 'out_of_range' ? '6~110mm' : ''})</span>`;
          infoEl.style.borderColor = '#7f1d1d';
          wEl.value = ''; hEl.value = ''; dEl.value = '';
          return;
        }

        // 자동값 설정
        wEl.value = result.b;
        hEl.value = result.h;
        dEl.value = result.t1;
        infoEl.innerHTML = `<span style="color:#34d399;">✓ Ø${diam} → <b>${result.b}×${result.h}</b> (축지름 ${result.dMin}~${result.dMax}mm) / t1=${result.t1}</span>`;
        infoEl.style.borderColor = '#2d4a2d';
      }

      // v178: 우측 이격 자동 계산: 구간 길이 − (키 길이L + 좌측 이격)
      function _updateKeywayRightOffset(k) {
        const rightEl = keywayInputsDiv.querySelector(`.kw-right-off[data-kw-idx="${k}"]`);
        if (!rightEl) return;
        const secVal = keywayInputsDiv.querySelector(`.kw-sec[data-kw-idx="${k}"]`)?.value || '';
        const { length: shaftLen } = _getSectionDims(secVal);
        // v178: 길이(L) 필드 사용 (기존 폭(w) 대신)
        const kwLen = parseFloat(keywayInputsDiv.querySelector(`.kw-len[data-kw-idx="${k}"]`)?.value);
        const leftOff = parseFloat(keywayInputsDiv.querySelector(`.kw-left-off[data-kw-idx="${k}"]`)?.value);

        if (!isNaN(shaftLen) && !isNaN(kwLen) && !isNaN(leftOff)) {
          const right = shaftLen - (kwLen + leftOff);
          rightEl.value = Math.round(right * 100) / 100;
          rightEl.style.color = right < 0 ? '#f87171' : '#34d399';
          const warn = keywayInputsDiv.querySelector(`.kw-right-warn[data-kw-idx="${k}"]`);
          if (warn) warn.style.display = right < 0 ? 'block' : 'none';
        } else {
          rightEl.value = '';
          const warn = keywayInputsDiv.querySelector(`.kw-right-warn[data-kw-idx="${k}"]`);
          if (warn) warn.style.display = 'none';
        }
      }

      // 구간 수 변경 시 키홈 select 옵션도 업데이트
      function updateKeywaySelects(secCount) {
        keywayInputsDiv.querySelectorAll('.kw-sec').forEach(sel => {
          const val = sel.value;
          sel.innerHTML = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            sel.innerHTML += `<option value="S${s + 1}">S${s + 1}</option>`;
          }
          sel.value = val;
        });
      }

      // ★ 키홈 수 변경 — 모든 이벤트 유형 등록 (브라우저 호환성 보장)
      buildKeywayInputs(0);
      let _lastKwCount = 0;
      function onKeywayCountChange() {
        const n = Math.min(Math.max(parseInt(keywayCountInput.value) || 0, 0), 10);
        if (n === _lastKwCount) return;  // 중복 호출 방지
        _lastKwCount = n;
        keywayCountInput.value = n;
        buildKeywayInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        keywayCountInput.addEventListener(evt, onKeywayCountChange);
      });

      // v178: 모든 키홈 블록의 KS 규격 재조회 (직경 변경 시)
      function refreshAllKeywayBlocks() {
        const n = parseInt(keywayCountInput.value) || 0;
        for (let k = 0; k < n; k++) {
          _refreshKeywayKS(k);
        }
      }

      // ── 스냅링 동적 입력 빌더 (KS B 1336 C형 멈춤링 자동 선택) ──
      // 선택한 구간(S#)의 축지름/축길이를 읽어온다.
      function _getSectionDims(secVal) {
        if (!secVal) return { diam: NaN, length: NaN };
        const idx = parseInt(String(secVal).replace(/^S/i, ''), 10) - 1;
        if (isNaN(idx) || idx < 0) return { diam: NaN, length: NaN };
        const diamEl = sectionInputsDiv.querySelector(`.sec-diameter[data-idx="${idx}"]`);
        const lenEl = sectionInputsDiv.querySelector(`.sec-length[data-idx="${idx}"]`);
        return {
          diam: diamEl ? parseFloat(diamEl.value) : NaN,
          length: lenEl ? parseFloat(lenEl.value) : NaN,
        };
      }

      // 블록 하나의 자동/수동 상태를 다시 계산해서 표시한다.
      function refreshSnapRingBlock(k) {
        const block = snapRingInputsDiv.querySelector(`.sr-block[data-sr-idx="${k}"]`);
        if (!block) return;
        const secVal = block.querySelector('.sr-sec')?.value || '';
        const { diam: shaftDiam, length: shaftLen } = _getSectionDims(secVal);

        const autoBox = block.querySelector('.sr-auto-box');
        const noSpecBox = block.querySelector('.sr-nospec-box');
        const manualBox = block.querySelector('.sr-manual-box');
        const infoLine = block.querySelector('.sr-info-line');

        // 구간 미선택 상태
        if (!secVal || isNaN(shaftDiam)) {
          block.setAttribute('data-sr-mode', 'none');
          if (autoBox) autoBox.style.display = 'none';
          if (noSpecBox) noSpecBox.style.display = 'none';
          if (manualBox) manualBox.style.display = 'none';
          if (infoLine) infoLine.textContent = secVal
            ? `⚠ ${secVal} 구간의 직경을 먼저 입력하세요.`
            : '구간을 선택하면 축지름에 따라 자동으로 스냅링 규격이 선택됩니다.';
          _updateSnapRingRightOffset(k);
          return;
        }

        const lookup = (typeof DrawingModel !== 'undefined' && DrawingModel.lookupSnapRingByShaft)
          ? DrawingModel.lookupSnapRingByShaft(shaftDiam)
          : { found: false, reason: 'not_standard', d1: shaftDiam, min: 10, max: 95 };

        if (lookup.found) {
          // 자동 모드: KS 규격에서 외경(d2)·두께(m) 자동 선택
          block.setAttribute('data-sr-mode', 'auto');
          if (autoBox) autoBox.style.display = 'block';
          if (noSpecBox) noSpecBox.style.display = 'none';
          if (manualBox) manualBox.style.display = 'none';

          const d2El = block.querySelector('.sr-auto-d2');
          const mEl = block.querySelector('.sr-auto-m');
          const d1El = block.querySelector('.sr-auto-d1');
          if (d1El) d1El.value = lookup.d1;
          if (d2El) d2El.value = lookup.d2;
          if (mEl) mEl.value = lookup.m;
          // 자동 계산값을 hidden 데이터로 저장 (collectFormData에서 사용)
          block.setAttribute('data-sr-diam', lookup.d2);
          block.setAttribute('data-sr-thick', lookup.m);

          if (infoLine) infoLine.textContent =
            `✔ 축지름 ${lookup.d1} → 스냅링 외경 ${lookup.d2}Ø · 두께 ${lookup.m}t (KS B 1336)`;
        } else {
          // 규격 외: "규격에 없습니다" + 수동 입력 노출
          block.setAttribute('data-sr-mode', 'manual');
          block.removeAttribute('data-sr-diam');
          block.removeAttribute('data-sr-thick');
          if (autoBox) autoBox.style.display = 'none';
          if (noSpecBox) noSpecBox.style.display = 'block';
          if (manualBox) manualBox.style.display = 'block';

          const reasonMsg = block.querySelector('.sr-nospec-reason');
          if (reasonMsg) {
            let msg;
            if (lookup.reason === 'too_small') msg = `축지름 ${lookup.d1} < 최소 ${lookup.min}`;
            else if (lookup.reason === 'too_large') msg = `축지름 ${lookup.d1} > 최대 ${lookup.max}`;
            else msg = `축지름 ${lookup.d1} 은(는) 규격 기준값이 아닙니다`;
            reasonMsg.textContent = `(${msg})`;
          }
          if (infoLine) infoLine.textContent = '규격에 없어 수동으로 외경·두께를 입력합니다.';
        }
        _updateSnapRingRightOffset(k);
      }

      // 우측 이격 자동 계산: 축길이 − (두께 + 좌측 이격)
      function _updateSnapRingRightOffset(k) {
        const block = snapRingInputsDiv.querySelector(`.sr-block[data-sr-idx="${k}"]`);
        if (!block) return;
        const secVal = block.querySelector('.sr-sec')?.value || '';
        const { length: shaftLen } = _getSectionDims(secVal);
        const mode = block.getAttribute('data-sr-mode');

        let thick = NaN;
        if (mode === 'auto') {
          thick = parseFloat(block.getAttribute('data-sr-thick'));
        } else if (mode === 'manual') {
          thick = parseFloat(block.querySelector('.sr-thick')?.value);
        }
        const leftOff = parseFloat(block.querySelector('.sr-left-off')?.value);
        const rightEl = block.querySelector('.sr-right-off');
        if (!rightEl) return;

        if (!isNaN(shaftLen) && !isNaN(thick) && !isNaN(leftOff)) {
          const right = shaftLen - (thick + leftOff);
          rightEl.value = Math.round(right * 100) / 100;
          rightEl.style.color = right < 0 ? '#f87171' : '#34d399';
          const warn = block.querySelector('.sr-right-warn');
          if (warn) warn.style.display = right < 0 ? 'block' : 'none';
        } else {
          rightEl.value = '';
          const warn = block.querySelector('.sr-right-warn');
          if (warn) warn.style.display = 'none';
        }
      }

      function buildSnapRingInputs(srCount) {
        snapRingInputsDiv.innerHTML = '';
        const secCount = parseInt(countInput.value) || 0;

        for (let k = 0; k < srCount; k++) {
          const block = document.createElement('div');
          block.className = 'sr-block';
          block.setAttribute('data-sr-idx', k);
          block.setAttribute('data-sr-mode', 'none');
          block.style.cssText = 'background:#1e2230; border:1px solid #be185d; border-radius:8px; padding:12px;';

          let secOptions = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            secOptions += `<option value="S${s + 1}">S${s + 1}</option>`;
          }

          block.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
              <label style="font-size:12px; color:#f472b6; font-weight:600;">스냅링 ${k + 1}</label>
              <span style="font-size:10px; color:#6b7280;">적용 구간</span>
              <select class="sr-sec" data-sr-idx="${k}" style="width:70px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                ${secOptions}
              </select>
            </div>

            <div class="sr-info-line" style="font-size:10px; color:#93c5fd; margin-bottom:8px; line-height:1.4;">
              구간을 선택하면 축지름에 따라 자동으로 스냅링 규격이 선택됩니다.
            </div>

            <!-- 좌측 이격 (사용자 입력) -->
            <div style="margin-bottom:6px;">
              <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">좌측 오프셋 (mm) — 구간 좌측에서 스냅링까지 거리</label>
              <input type="number" class="sr-left-off" data-sr-idx="${k}" placeholder="예: 5" step="0.1"
                style="width:100%; padding:6px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:13px;">
            </div>

            <!-- 자동 선택 결과 (읽기 전용) -->
            <div class="sr-auto-box" style="display:none; background:#152029; border:1px solid #0e7490; border-radius:6px; padding:8px; margin-bottom:6px;">
              <div style="font-size:10px; color:#22d3ee; margin-bottom:4px; font-weight:600;">▽ KS B 1336 자동 선택 (허용차 무시)</div>
              <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px;">
                <div>
                  <label style="font-size:9px; color:#6b7280; display:block; margin-bottom:2px;">축지름 d1</label>
                  <input type="number" class="sr-auto-d1" data-sr-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #2b3340; border-radius:6px; color:#94a3b8; font-size:12px;">
                </div>
                <div>
                  <label style="font-size:9px; color:#22d3ee; display:block; margin-bottom:2px;">외경 d2</label>
                  <input type="number" class="sr-auto-d2" data-sr-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #0e7490; border-radius:6px; color:#67e8f9; font-size:12px; font-weight:600;">
                </div>
                <div>
                  <label style="font-size:9px; color:#22d3ee; display:block; margin-bottom:2px;">두께 m</label>
                  <input type="number" class="sr-auto-m" data-sr-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #0e7490; border-radius:6px; color:#67e8f9; font-size:12px; font-weight:600;">
                </div>
              </div>
            </div>

            <!-- 규격 외 안내 배너 -->
            <div class="sr-nospec-box" style="display:none; background:#2a1215; border:1px solid #b91c1c; border-radius:6px; padding:8px; margin-bottom:6px;">
              <div style="font-size:12px; color:#fca5a5; font-weight:700;">⚠ 규격에 없습니다</div>
              <div class="sr-nospec-reason" style="font-size:10px; color:#f87171; margin-top:2px;"></div>
              <div style="font-size:10px; color:#94a3b8; margin-top:3px;">아래에서 외경·두께를 직접 입력하세요.</div>
            </div>

            <!-- 수동 입력 (규격 외일 때만 노출) -->
            <div class="sr-manual-box" style="display:none; margin-bottom:6px;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                <div>
                  <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">스냅링 외경 (mm)</label>
                  <input type="number" class="sr-diam" data-sr-idx="${k}" placeholder="예: 17" step="0.1"
                    style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
                <div>
                  <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">두께 (mm)</label>
                  <input type="number" class="sr-thick" data-sr-idx="${k}" placeholder="예: 1.5" step="0.1"
                    style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
              </div>
            </div>

            <!-- 우측 이격 (자동 계산, 읽기 전용) -->
            <div>
              <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">우측 오프셋 (mm) — 자동 계산: 축길이 − (두께 + 좌측 오프셋)</label>
              <input type="number" class="sr-right-off" data-sr-idx="${k}" placeholder="자동 계산" readonly
                style="width:100%; padding:6px; background:#151b12; border:1px solid #554a20; border-radius:6px; color:#34d399; font-size:13px;">
              <div class="sr-right-warn" style="display:none; font-size:10px; color:#f87171; margin-top:2px;">
                ⚠ 우측 오프셋이 음수입니다. 좌측 오프셋 또는 축길이를 확인하세요.
              </div>
            </div>

            <div style="font-size:10px; color:#6b7280; margin-top:6px;">
              * 홈 깊이 = (구간 외경 − 스냅링 외경) / 2
            </div>
          `;
          snapRingInputsDiv.appendChild(block);

          // 이벤트 바인딩
          const secSel = block.querySelector('.sr-sec');
          const leftOffEl = block.querySelector('.sr-left-off');
          const manualDiamEl = block.querySelector('.sr-diam');
          const manualThickEl = block.querySelector('.sr-thick');

          ['input', 'change'].forEach(evt => {
            secSel && secSel.addEventListener(evt, () => {
              refreshSnapRingBlock(k);
              // 스냅링 구간 변경 시 베어링 자동 연동
              _syncBearingFromSnapRings();
            });
            leftOffEl && leftOffEl.addEventListener(evt, () => {
              _updateSnapRingRightOffset(k);
              // 좌측 오프셋 변경 시 대응하는 베어링의 폭 적합성 재검사
              _recheckBearingSnapRingFitAll();
            });
            manualThickEl && manualThickEl.addEventListener(evt, () => {
              _updateSnapRingRightOffset(k);
              _recheckBearingSnapRingFitAll();
            });
          });

          refreshSnapRingBlock(k);
        }
      }

      // 구간 수 변경 시 스냅링 select 옵션 업데이트 + 자동값 재계산
      function updateSnapRingSelects(secCount) {
        snapRingInputsDiv.querySelectorAll('.sr-sec').forEach(sel => {
          const val = sel.value;
          sel.innerHTML = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            sel.innerHTML += `<option value="S${s + 1}">S${s + 1}</option>`;
          }
          sel.value = val;
          const blk = sel.closest('.sr-block');
          if (blk) refreshSnapRingBlock(parseInt(blk.getAttribute('data-sr-idx'), 10));
        });
      }

      // 구간 직경/길이 변경 시 스냅링 자동값 갱신 (전역 재계산)
      function refreshAllSnapRingBlocks() {
        snapRingInputsDiv.querySelectorAll('.sr-block').forEach(blk => {
          refreshSnapRingBlock(parseInt(blk.getAttribute('data-sr-idx'), 10));
        });
      }

      // ── 베어링 ↔ 스냅링 연동: 스냅링 구간 변경 시 베어링 자동 설정 ──
      // 스냅링에서 유효한(구간 선택된) 항목들을 수집하고,
      // 베어링 수·위치를 자동 설정한다.
      function _syncBearingFromSnapRings() {
        // 1) 스냅링 블록에서 유효한 구간(섹션) 목록 수집 (갯수 기준: 스냅링 수 = 베어링 수)
        const srCount = parseInt(snapRingCountInput.value) || 0;
        const validSections = [];
        const allBlocks = snapRingInputsDiv.querySelectorAll('.sr-block');
        allBlocks.forEach(blk => {
          const sec = blk.querySelector('.sr-sec')?.value || '';
          validSections.push(sec); // 빈 값도 포함 (갯수 맞추기 위해)
        });
        console.log('[_syncBearingFromSnapRings] srCount:', srCount, 'sections:', validSections);

        // 스냅링 갯수 = 베어링 갯수 (구간 미선택 스냅링도 포함)
        const newCount = srCount;

        // 2) 베어링 카운트 자동 설정
        bearingCountInput.value = newCount;
        _lastBrCount = newCount;
        buildBearingInputs(newCount);

        // 3) 각 베어링에 대응하는 스냅링의 구간 자동 설정
        for (let i = 0; i < newCount; i++) {
          const sec = validSections[i] || '';
          const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${i}"]`);
          if (block && sec) {
            const secSel = block.querySelector('.br-sec');
            if (secSel) {
              secSel.value = sec;
              refreshBearingBlock(i);
            }
          }
        }

        // 4) 베어링 입력 활성/비활성 상태 갱신
        _updateBearingLockState();
      }

      // 베어링 입력 잠금 상태 업데이트 (스냅링 없으면 차단)
      function _updateBearingLockState() {
        const srCount = parseInt(snapRingCountInput.value) || 0;

        if (srCount === 0) {
          // 스냅링 없음 → 베어링 차단
          bearingCountInput.setAttribute('readonly', '');
          bearingCountInput.style.color = '#6b7280';
          bearingCountInput.style.cursor = 'not-allowed';
          bearingCountInput.title = '스냅링을 먼저 입력하세요';
        } else {
          // 스냅링 존재 → readonly (자동 연동), 활성 스타일
          bearingCountInput.setAttribute('readonly', '');
          bearingCountInput.style.color = '#38bdf8';
          bearingCountInput.style.cursor = 'default';
          bearingCountInput.title = '스냅링에 연동되어 자동 설정됩니다';
        }
      }

      // 베어링 경고 토스트 표시
      let _bearingToastTimer = null;
      function _showBearingSnapToast() {
        const toast = document.getElementById('bearingSnapWarnToast');
        if (!toast) return;
        toast.style.display = 'block';
        if (_bearingToastTimer) clearTimeout(_bearingToastTimer);
        _bearingToastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
      }

      // ★ 스냅링 수 변경 — 모든 이벤트 유형 등록
      buildSnapRingInputs(0);
      let _lastSrCount = 0;
      function onSnapRingCountChange() {
        const n = Math.min(Math.max(parseInt(snapRingCountInput.value) || 0, 0), 10);
        if (n === _lastSrCount) return;
        _lastSrCount = n;
        snapRingCountInput.value = n;
        buildSnapRingInputs(n);
        // 스냅링 수 변경 시 베어링 자동 연동
        _syncBearingFromSnapRings();
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        snapRingCountInput.addEventListener(evt, onSnapRingCountChange);
      });

      // ============================================================
      // ── 베어링(깊은 홈 볼베어링 KS B 2023) 동적 입력 빌더 ──
      //   호칭번호 입력 + 구간 선택 → 규격표에서 d/D/B/r 조회.
      //   호칭번호 d ≠ 구간 축지름 → 억지끼워맞춤 모달.
      //   좌측 오프셋 입력 → 우측 오프셋 = 축길이 − (B + 좌측) 자동.
      // ============================================================

      // 우측 오프셋 자동 계산: 축길이 − (베어링 폭 B + 좌측 오프셋)
      function _updateBearingRightOffset(k) {
        const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);
        if (!block) return;
        const secVal = block.querySelector('.br-sec')?.value || '';
        const { length: shaftLen } = _getSectionDims(secVal);
        const B = parseFloat(block.getAttribute('data-br-B'));
        const leftOff = parseFloat(block.querySelector('.br-left-off')?.value);
        const rightEl = block.querySelector('.br-right-off');
        if (!rightEl) return;
        if (!isNaN(shaftLen) && !isNaN(B) && !isNaN(leftOff)) {
          const right = shaftLen - (B + leftOff);
          rightEl.value = Math.round(right * 100) / 100;
          rightEl.style.color = right < 0 ? '#f87171' : '#34d399';
          const warn = block.querySelector('.br-right-warn');
          if (warn) warn.style.display = right < 0 ? 'block' : 'none';
        } else {
          rightEl.value = '';
          const warn = block.querySelector('.br-right-warn');
          if (warn) warn.style.display = 'none';
        }
      }

      // ── 베어링 폭 vs 스냅링 오프셋 적합성 검사 + 자동 오프셋 입력 ──
      // 같은 구간의 스냅링 오프셋과 베어링 폭 B 비교:
      //   B ≤ min(좌,우) → 작은쪽에 자동 배치, 오프셋 자동 입력
      //   B > min but B ≤ max → 모달에서 반대쪽(큰쪽) 선택 가능
      //   B > max → 양쪽 모두 불가 경고
      function _checkBearingSnapRingFit(k) {
        const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);
        if (!block) return;
        const secVal = block.querySelector('.br-sec')?.value || '';
        const B = parseFloat(block.getAttribute('data-br-B'));
        if (!secVal || isNaN(B) || B <= 0) return;

        // 같은 구간의 스냅링 찾기
        snapRingInputsDiv.querySelectorAll('.sr-block').forEach(srBlk => {
          const srSec = srBlk.querySelector('.sr-sec')?.value || '';
          if (srSec !== secVal) return;

          const srLeftOff = parseFloat(srBlk.querySelector('.sr-left-off')?.value);
          const srRightOff = parseFloat(srBlk.querySelector('.sr-right-off')?.value);
          if (isNaN(srLeftOff) && isNaN(srRightOff)) return;

          // 유효한 오프셋으로 min/max 결정
          let minOff, maxOff, minSide, maxSide;
          if (!isNaN(srLeftOff) && !isNaN(srRightOff)) {
            if (srLeftOff <= srRightOff) {
              minOff = srLeftOff; minSide = '좌측'; maxOff = srRightOff; maxSide = '우측';
            } else {
              minOff = srRightOff; minSide = '우측'; maxOff = srLeftOff; maxSide = '좌측';
            }
          } else if (!isNaN(srLeftOff)) {
            minOff = srLeftOff; minSide = '좌측'; maxOff = srLeftOff; maxSide = '좌측';
          } else {
            minOff = srRightOff; minSide = '우측'; maxOff = srRightOff; maxSide = '우측';
          }

          // CASE 1: B ≤ 작은쪽 오프셋 → 작은쪽에 자동 배치 + 오프셋 자동 입력
          if (B <= minOff + 0.01) {
            _autoBearingOffset(k, minSide, B, srLeftOff, srRightOff);
            return;
          }

          // CASE 2: B > 작은쪽이지만 B ≤ 큰쪽 → 반대쪽 선택 가능 모달
          if (B <= maxOff + 0.01 && minSide !== maxSide) {
            _showBearingSnapMismatchModal(k, secVal, B, minOff, minSide, maxOff, maxSide, srLeftOff, srRightOff, true);
            return;
          }

          // CASE 3: 양쪽 모두 불가 → 경고 모달 (변경 안내)
          _showBearingSnapMismatchModal(k, secVal, B, minOff, minSide, maxOff, maxSide, srLeftOff, srRightOff, false);
        });
      }

      // 베어링 오프셋 자동 입력 — 스냅링 오프셋 쪽에 배치
      // placeSide: '좌측' 또는 '우측' — 베어링이 배치되는 방향
      function _autoBearingOffset(k, placeSide, B, srLeftOff, srRightOff) {
        const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);
        if (!block) return;
        const leftOffEl = block.querySelector('.br-left-off');
        if (!leftOffEl) return;

        if (placeSide === '좌측') {
          // 베어링이 좌측에 위치: 베어링 좌측 오프셋 = 스냅링 좌측 오프셋 − B
          const brLeftOff = Math.round((srLeftOff - B) * 100) / 100;
          leftOffEl.value = brLeftOff >= 0 ? brLeftOff : 0;
        } else {
          // 베어링이 우측에 위치: 베어링 좌측 오프셋 = 구간길이 − 스냅링 우측 오프셋
          // → 즉, 우측 오프셋 = 스냅링 우측 오프셋 − B 가 되도록 좌측 오프셋 역산
          // 우측 오프셋 = 축길이 − (B + 좌측 오프셋)  →  좌측 오프셋 = 축길이 − B − (srRightOff − B) = 축길이 − srRightOff
          // 더 직관적: 베어링 우측 끝 = 스냅링 위치 기준 우측으로 srRightOff만큼 → 베어링 우측 오프셋 = srRightOff - B
          const secVal = block.querySelector('.br-sec')?.value || '';
          const { length: shaftLen } = _getSectionDims(secVal);
          if (!isNaN(shaftLen)) {
            // 좌측 오프셋 = 축길이 − 우측 오프셋 잔여 − B
            // 우측 오프셋을 (srRightOff - B)로 맞추려면:  좌측 = 축길이 - B - (srRightOff - B) = 축길이 - srRightOff
            const brLeftOff = Math.round((shaftLen - srRightOff) * 100) / 100;
            leftOffEl.value = brLeftOff >= 0 ? brLeftOff : 0;
          }
        }

        // 우측 오프셋 자동 재계산
        _updateBearingRightOffset(k);
        console.log(`[_autoBearingOffset] BR[${k}] → ${placeSide} 배치, leftOff=${leftOffEl.value}`);
      }

      // 스냅링 오프셋 변경 시 모든 베어링 재검사
      function _recheckBearingSnapRingFitAll() {
        bearingInputsDiv.querySelectorAll('.br-block').forEach(blk => {
          _checkBearingSnapRingFit(parseInt(blk.getAttribute('data-br-idx'), 10));
        });
      }

      // 베어링-스냅링 불일치 경고 모달
      // canFlip: true면 반대쪽(큰 오프셋) 배치 버튼 표시
      function _showBearingSnapMismatchModal(k, secVal, bearingWidth, minOffset, minSide, maxOffset, maxSide, leftOff, rightOff, canFlip) {
        // 기존 모달 있으면 중복 방지
        if (document.getElementById('bearingSnapMismatchModal')) return;
        const modal = document.createElement('div');
        modal.id = 'bearingSnapMismatchModal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:100001; display:flex; align-items:center; justify-content:center;';

        const reduceHint = `${minSide}오프셋을 줄이거나`;

        // 반대쪽 배치 버튼 HTML
        const flipBtnHtml = canFlip ? `
            <div style="font-size:13px; color:#34d399; background:#0a2018; border:1px solid #059669; border-radius:8px; padding:10px; margin-bottom:12px; line-height:1.6;">
              <b>또는:</b> 반대쪽(<b>${maxSide}</b>, ${maxOffset}mm)에 베어링을 배치할 수 있습니다.
            </div>
        ` : '';

        const flipBtn = canFlip ? `
              <button id="bsmFlip" style="padding:9px 18px; background:linear-gradient(135deg,#059669,#047857); border:none; border-radius:8px; color:white; cursor:pointer; font-size:13px; font-weight:600;">${maxSide}에 배치</button>
        ` : '';

        modal.innerHTML = `
          <div style="background:#1e2230; border:1px solid #f59e0b; border-radius:12px; padding:24px; max-width:460px; box-shadow:0 10px 40px rgba(0,0,0,0.5);">
            <div style="font-size:16px; color:#fbbf24; font-weight:700; margin-bottom:10px;">⚠ 베어링-스냅링 이탈 경고</div>
            <div style="font-size:13px; color:#e2e8f0; line-height:1.7; margin-bottom:10px;">
              베어링 ${k + 1} (구간 ${secVal})의 <b>폭(B) = ${bearingWidth}mm</b>가<br>
              스냅링의 오프셋 최솟값 <b>(${minSide}오프셋 = ${minOffset}mm)</b>과 일치하지 않습니다.
            </div>
            <div style="font-size:12px; color:#94a3b8; margin-bottom:8px;">
              · 스냅링 좌측오프셋 = ${isNaN(leftOff) ? '미입력' : leftOff + 'mm'}<br>
              · 스냅링 우측오프셋 = ${isNaN(rightOff) ? '미입력' : rightOff + 'mm'}<br>
              · 베어링 폭 B = ${bearingWidth}mm
            </div>
            <div style="font-size:13px; color:#fbbf24; background:#2a2008; border:1px solid #854d0e; border-radius:8px; padding:10px; margin-bottom:12px; line-height:1.6;">
              <b>조치 방법:</b><br>
              스냅링의 <b>${reduceHint}</b> 삽입하려는 베어링을 변경하세요.
            </div>
            ${flipBtnHtml}
            <div style="display:flex; justify-content:flex-end; gap:10px;">
              ${flipBtn}
              <button id="bsmOk" style="padding:9px 24px; background:linear-gradient(135deg,#f59e0b,#d97706); border:none; border-radius:8px; color:white; cursor:pointer; font-size:13px; font-weight:600;">확인</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#bsmOk').addEventListener('click', () => modal.remove());

        // 반대쪽 배치 버튼 이벤트
        if (canFlip) {
          const flipBtnEl = modal.querySelector('#bsmFlip');
          if (flipBtnEl) {
            flipBtnEl.addEventListener('click', () => {
              // 큰 오프셋 쪽에 배치 → 오프셋 자동 입력
              _autoBearingOffset(k, maxSide, bearingWidth, leftOff, rightOff);
              modal.remove();
            });
          }
        }
      }

      // 호칭번호 + 구간 조회 → 규격 표시 + 축지름 일치 검사
      function refreshBearingBlock(k) {
        const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);
        if (!block) return;
        const desig = (block.querySelector('.br-desig')?.value || '').trim();
        const secVal = block.querySelector('.br-sec')?.value || '';
        const { diam: shaftDiam } = _getSectionDims(secVal);

        const specBox = block.querySelector('.br-spec-box');
        const infoLine = block.querySelector('.br-info-line');
        const mismatchBox = block.querySelector('.br-mismatch-box');

        // 초기화
        block.removeAttribute('data-br-B');
        block.removeAttribute('data-br-D');
        block.removeAttribute('data-br-d');
        block.removeAttribute('data-br-r');
        block.setAttribute('data-br-fit', 'ok'); // ok | forced | invalid

        if (!desig) {
          if (specBox) specBox.style.display = 'none';
          if (mismatchBox) mismatchBox.style.display = 'none';
          if (infoLine) infoLine.textContent = '베어링 호칭번호와 적용 구간을 선택하세요.';
          _updateBearingRightOffset(k);
          return;
        }

        const lookup = (typeof DrawingModel !== 'undefined' && DrawingModel.lookupBearingByDesignation)
          ? DrawingModel.lookupBearingByDesignation(desig)
          : { found: false, reason: 'not_found', designation: desig };

        if (!lookup.found) {
          if (specBox) specBox.style.display = 'none';
          if (mismatchBox) mismatchBox.style.display = 'none';
          block.setAttribute('data-br-fit', 'invalid');
          if (infoLine) { infoLine.style.color = '#f87171'; infoLine.textContent = `⚠ 호칭번호 "${desig}" 는 규격표에 없습니다.`; }
          _updateBearingRightOffset(k);
          return;
        }

        // 규격 조회 성공 → 값 표시
        block.setAttribute('data-br-B', lookup.B);
        block.setAttribute('data-br-D', lookup.D);
        block.setAttribute('data-br-d', lookup.d);
        block.setAttribute('data-br-r', lookup.r);
        if (specBox) specBox.style.display = 'block';
        const dEl = block.querySelector('.br-spec-d');
        const DEl = block.querySelector('.br-spec-D');
        const BEl = block.querySelector('.br-spec-B');
        const rEl = block.querySelector('.br-spec-r');
        if (dEl) dEl.value = lookup.d;
        if (DEl) DEl.value = lookup.D;
        if (BEl) BEl.value = lookup.B;
        if (rEl) rEl.value = lookup.r;

        if (infoLine) { infoLine.style.color = '#93c5fd'; infoLine.textContent = `✔ ${lookup.designation} (계열 ${lookup.series}) — 내경 d=${lookup.d} · 외경 D=${lookup.D} · 폭 B=${lookup.B} · 필렛 r=${lookup.r}`; }

        // 축지름 일치 검사
        if (!secVal || isNaN(shaftDiam)) {
          // 구간 미선택 or 직경 미입력 — 일치 검사 보류
          if (mismatchBox) mismatchBox.style.display = 'none';
          block.setAttribute('data-br-fit', 'ok');
        } else if (Math.abs(shaftDiam - lookup.d) < 0.001) {
          // 일치 → 정상
          if (mismatchBox) mismatchBox.style.display = 'none';
          block.setAttribute('data-br-fit', 'ok');
        } else {
          // 불일치 → 억지끼워맞춤 모달 (이미 forced로 확정된 경우 유지)
          const already = block.getAttribute('data-br-forced-confirmed') === 'true';
          if (already) {
            block.setAttribute('data-br-fit', 'forced');
            if (mismatchBox) {
              mismatchBox.style.display = 'block';
              mismatchBox.querySelector('.br-mismatch-msg').textContent =
                `억지 끼워맞춤 적용됨: 베어링 내경 d=${lookup.d} ≠ 축지름 ${shaftDiam}`;
            }
          } else {
            block.setAttribute('data-br-fit', 'ok'); // 모달 응답 전까지는 미확정
            _showBearingFitModal(k, lookup.d, shaftDiam);
          }
        }
        _updateBearingRightOffset(k);
        // 베어링 폭 vs 스냅링 오프셋 적합성 검사
        if (lookup && lookup.found) _checkBearingSnapRingFit(k);
      }

      // 억지끼워맞춤 확인 모달
      function _showBearingFitModal(k, bearingBore, shaftDiam) {
        // 중복 방지
        if (document.getElementById('bearingFitModal')) return;
        const modal = document.createElement('div');
        modal.id = 'bearingFitModal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:100000; display:flex; align-items:center; justify-content:center;';
        modal.innerHTML = `
          <div style="background:#1e2230; border:1px solid #b91c1c; border-radius:12px; padding:24px; max-width:420px; box-shadow:0 10px 40px rgba(0,0,0,0.5);">
            <div style="font-size:16px; color:#fca5a5; font-weight:700; margin-bottom:10px;">⚠ 베어링 삽입 불가능</div>
            <div style="font-size:13px; color:#e2e8f0; line-height:1.6; margin-bottom:8px;">
              선택한 베어링의 내경(d)과 구간 축지름이 일치하지 않습니다.
            </div>
            <div style="font-size:13px; color:#fbbf24; margin-bottom:16px;">
              · 베어링 내경 d = <b>${bearingBore}</b> mm<br>
              · 구간 축지름 = <b>${shaftDiam}</b> mm
            </div>
            <div style="font-size:13px; color:#e2e8f0; margin-bottom:18px;">
              <b>억지 끼워맞춤</b>을 하시겠습니까?
            </div>
            <div style="display:flex; justify-content:flex-end; gap:10px;">
              <button id="bfmNo" style="padding:9px 18px; background:#374151; border:none; border-radius:8px; color:#e2e8f0; cursor:pointer; font-size:13px;">아니오</button>
              <button id="bfmYes" style="padding:9px 18px; background:linear-gradient(135deg,#dc2626,#b91c1c); border:none; border-radius:8px; color:white; cursor:pointer; font-size:13px; font-weight:600;">예 (억지 끼워맞춤)</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);

        modal.querySelector('#bfmYes').addEventListener('click', () => {
          if (block) {
            block.setAttribute('data-br-forced-confirmed', 'true');
            block.setAttribute('data-br-fit', 'forced');
          }
          modal.remove();
          refreshBearingBlock(k);
        });
        modal.querySelector('#bfmNo').addEventListener('click', () => {
          // 아니오: 모달 내리고 사용자가 다시 선택하게 함 (호칭번호/구간 초기화하지 않고 그대로 두되 fit=ok 유지)
          if (block) {
            block.removeAttribute('data-br-forced-confirmed');
            block.setAttribute('data-br-fit', 'ok');
            const mismatchBox = block.querySelector('.br-mismatch-box');
            if (mismatchBox) mismatchBox.style.display = 'none';
            const infoLine = block.querySelector('.br-info-line');
            if (infoLine) { infoLine.style.color = '#f59e0b'; infoLine.textContent = '다른 베어링 호칭번호 또는 다른 구간을 선택하세요.'; }
          }
          modal.remove();
        });
      }

      function buildBearingInputs(brCount) {
        bearingInputsDiv.innerHTML = '';
        const secCount = parseInt(countInput.value) || 0;
        for (let k = 0; k < brCount; k++) {
          const block = document.createElement('div');
          block.className = 'br-block';
          block.setAttribute('data-br-idx', k);
          block.setAttribute('data-br-fit', 'ok');
          block.style.cssText = 'background:#1e2230; border:1px solid #0369a1; border-radius:8px; padding:12px;';

          let secOptions = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            secOptions += `<option value="S${s + 1}">S${s + 1}</option>`;
          }

          block.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
              <label style="font-size:12px; color:#38bdf8; font-weight:600;">베어링 ${k + 1}</label>
              <span style="font-size:10px; color:#6b7280;">적용 구간</span>
              <select class="br-sec" data-br-idx="${k}" style="width:70px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                ${secOptions}
              </select>
              <span style="font-size:10px; color:#6b7280;">호칭번호</span>
              <input type="text" class="br-desig" data-br-idx="${k}" placeholder="예: 6206"
                style="width:90px; padding:4px 6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
            </div>

            <div class="br-info-line" style="font-size:10px; color:#93c5fd; margin-bottom:8px; line-height:1.4;">
              베어링 호칭번호와 적용 구간을 선택하세요.
            </div>

            <!-- 규격 조회 결과 (읽기 전용) -->
            <div class="br-spec-box" style="display:none; background:#0c1a24; border:1px solid #0369a1; border-radius:6px; padding:8px; margin-bottom:6px;">
              <div style="font-size:10px; color:#38bdf8; margin-bottom:4px; font-weight:600;">◎ KS B 2023 깊은 홈 볼베어링 규격</div>
              <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:6px;">
                <div>
                  <label style="font-size:9px; color:#6b7280; display:block; margin-bottom:2px;">내경 d</label>
                  <input type="number" class="br-spec-d" data-br-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #2b3340; border-radius:6px; color:#94a3b8; font-size:12px;">
                </div>
                <div>
                  <label style="font-size:9px; color:#38bdf8; display:block; margin-bottom:2px;">외경 D</label>
                  <input type="number" class="br-spec-D" data-br-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #0369a1; border-radius:6px; color:#7dd3fc; font-size:12px; font-weight:600;">
                </div>
                <div>
                  <label style="font-size:9px; color:#38bdf8; display:block; margin-bottom:2px;">폭 B</label>
                  <input type="number" class="br-spec-B" data-br-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #0369a1; border-radius:6px; color:#7dd3fc; font-size:12px; font-weight:600;">
                </div>
                <div>
                  <label style="font-size:9px; color:#38bdf8; display:block; margin-bottom:2px;">필렛 r</label>
                  <input type="number" class="br-spec-r" data-br-idx="${k}" readonly
                    style="width:100%; padding:5px; background:#0f1620; border:1px solid #2b3340; border-radius:6px; color:#94a3b8; font-size:12px;">
                </div>
              </div>
            </div>

            <!-- 억지끼워맞춤 표시 배너 -->
            <div class="br-mismatch-box" style="display:none; background:#2a1215; border:1px solid #b91c1c; border-radius:6px; padding:8px; margin-bottom:6px;">
              <div style="font-size:12px; color:#fca5a5; font-weight:700;">⚠ 억지 끼워맞춤</div>
              <div class="br-mismatch-msg" style="font-size:10px; color:#f87171; margin-top:2px;"></div>
              <div style="font-size:10px; color:#94a3b8; margin-top:3px;">도면에 "억지 끼워맞춤"으로 표시됩니다.</div>
            </div>

            <!-- 좌측 오프셋 -->
            <div style="margin-bottom:6px;">
              <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">좌측 오프셋 (mm) — 구간 좌측에서 베어링까지 거리</label>
              <input type="number" class="br-left-off" data-br-idx="${k}" placeholder="예: 5" step="0.1"
                style="width:100%; padding:6px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:13px;">
            </div>

            <!-- 우측 오프셋 (자동) -->
            <div>
              <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">우측 오프셋 (mm) — 자동 계산: 축길이 − (폭 B + 좌측 오프셋)</label>
              <input type="number" class="br-right-off" data-br-idx="${k}" placeholder="자동 계산" readonly
                style="width:100%; padding:6px; background:#151b12; border:1px solid #554a20; border-radius:6px; color:#34d399; font-size:13px;">
              <div class="br-right-warn" style="display:none; font-size:10px; color:#f87171; margin-top:2px;">
                ⚠ 우측 오프셋이 음수입니다. 좌측 오프셋 또는 축길이를 확인하세요.
              </div>
            </div>

            <div style="font-size:10px; color:#6b7280; margin-top:6px;">
              * 베어링은 단면도로 표현됩니다 (외경 D × 폭 B).
            </div>
          `;
          bearingInputsDiv.appendChild(block);

          const secSel = block.querySelector('.br-sec');
          const desigEl = block.querySelector('.br-desig');
          const leftOffEl = block.querySelector('.br-left-off');

          ['input', 'change'].forEach(evt => {
            secSel && secSel.addEventListener(evt, () => refreshBearingBlock(k));
            desigEl && desigEl.addEventListener(evt, () => refreshBearingBlock(k));
            leftOffEl && leftOffEl.addEventListener(evt, () => _updateBearingRightOffset(k));
          });

          refreshBearingBlock(k);
        }
      }

      function updateBearingSelects(secCount) {
        bearingInputsDiv.querySelectorAll('.br-sec').forEach(sel => {
          const val = sel.value;
          sel.innerHTML = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            sel.innerHTML += `<option value="S${s + 1}">S${s + 1}</option>`;
          }
          sel.value = val;
          const blk = sel.closest('.br-block');
          if (blk) refreshBearingBlock(parseInt(blk.getAttribute('data-br-idx'), 10));
        });
      }

      function refreshAllBearingBlocks() {
        bearingInputsDiv.querySelectorAll('.br-block').forEach(blk => {
          refreshBearingBlock(parseInt(blk.getAttribute('data-br-idx'), 10));
        });
      }

      buildBearingInputs(0);
      _updateBearingLockState();
      let _lastBrCount = 0;
      function onBearingCountChange() {
        // 스냅링 연동 자동 전용 — 수동 변경 차단
        const n = Math.min(Math.max(parseInt(bearingCountInput.value) || 0, 0), 4);
        if (n === _lastBrCount) return;
        _lastBrCount = n;
        bearingCountInput.value = n;
        buildBearingInputs(n);
      }
      // 베어링 카운트 클릭 시 스냅링 없으면 경고 토스트
      bearingCountInput.addEventListener('mousedown', (e) => {
        const srCount = parseInt(snapRingCountInput.value) || 0;
        if (srCount === 0) {
          e.preventDefault();
          e.stopPropagation();
          _showBearingSnapToast();
        }
      });
      bearingCountInput.addEventListener('focus', (e) => {
        const srCount = parseInt(snapRingCountInput.value) || 0;
        if (srCount === 0) {
          e.target.blur();
          _showBearingSnapToast();
        }
      });

      // ── 관통 구멍 동적 입력 빌더 ──
      function buildThroughHoleInputs(thCount) {
        throughHoleInputsDiv.innerHTML = '';
        const secCount = parseInt(countInput.value) || 0;

        for (let k = 0; k < thCount; k++) {
          const block = document.createElement('div');
          block.style.cssText = 'background:#1e2230; border:1px solid #059669; border-radius:8px; padding:12px;';
          
          let secOptions = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            secOptions += `<option value="S${s + 1}">S${s + 1}</option>`;
          }

          block.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#34d399; font-weight:600;">관통 구멍 ${k + 1}</label>
              <select class="th-sec" data-th-idx="${k}" style="width:60px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                ${secOptions}
              </select>
            </div>
            <div style="display:grid; grid-template-columns:1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">구멍 직경 (mm)</label>
                <input type="number" class="th-diam" data-th-idx="${k}" placeholder="예: 5" step="0.1"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">좌측 이격 (mm)</label>
                <input type="number" class="th-offset" data-th-idx="${k}" placeholder="좌측에서 거리" step="0.1"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">우측 이격 (mm) <span style="color:#6b7280;">자동</span></label>
                <input type="number" class="th-right-off" data-th-idx="${k}" placeholder="자동 계산" readonly step="0.1"
                  style="width:100%; padding:5px; background:#1a1e28; border:1px solid #554a20; border-radius:6px; color:#34d399; font-size:12px; cursor:default;">
                <div class="th-right-warn" data-th-idx="${k}" style="display:none; font-size:10px; color:#f87171; margin-top:2px;">⚠ 구간 길이 초과</div>
              </div>
            </div>
            <div style="font-size:10px; color:#6b7280; margin-top:4px;">
              * 우측 이격 = 구간 길이 − (직경 + 좌측 이격) 자동 계산
            </div>
          `;
          throughHoleInputsDiv.appendChild(block);

          // 이벤트 바인딩: 좌측 이격·직경·구간 변경 시 우측 이격 자동 계산
          ['input', 'change'].forEach(evt => {
            block.querySelector('.th-offset')?.addEventListener(evt, () => _updateThroughHoleRightOffset(k));
            block.querySelector('.th-diam')?.addEventListener(evt, () => _updateThroughHoleRightOffset(k));
            block.querySelector('.th-sec')?.addEventListener(evt, () => _updateThroughHoleRightOffset(k));
          });
        }
      }

      // 우측 이격 자동 계산: 구간 길이 − (직경 + 좌측 이격)
      function _updateThroughHoleRightOffset(k) {
        const rightEl = throughHoleInputsDiv.querySelector(`.th-right-off[data-th-idx="${k}"]`);
        if (!rightEl) return;
        const secVal = throughHoleInputsDiv.querySelector(`.th-sec[data-th-idx="${k}"]`)?.value || '';
        const { length: shaftLen } = _getSectionDims(secVal);
        const diam = parseFloat(throughHoleInputsDiv.querySelector(`.th-diam[data-th-idx="${k}"]`)?.value);
        const leftOff = parseFloat(throughHoleInputsDiv.querySelector(`.th-offset[data-th-idx="${k}"]`)?.value);

        if (!isNaN(shaftLen) && !isNaN(diam) && !isNaN(leftOff)) {
          const right = shaftLen - (diam + leftOff);
          rightEl.value = Math.round(right * 100) / 100;
          rightEl.style.color = right < 0 ? '#f87171' : '#34d399';
          const warn = throughHoleInputsDiv.querySelector(`.th-right-warn[data-th-idx="${k}"]`);
          if (warn) warn.style.display = right < 0 ? 'block' : 'none';
        } else {
          rightEl.value = '';
          const warn = throughHoleInputsDiv.querySelector(`.th-right-warn[data-th-idx="${k}"]`);
          if (warn) warn.style.display = 'none';
        }
      }

      // 구간 수 변경 시 관통 구멍 select 옵션 업데이트
      function updateThroughHoleSelects(secCount) {
        throughHoleInputsDiv.querySelectorAll('.th-sec').forEach(sel => {
          const val = sel.value;
          sel.innerHTML = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            sel.innerHTML += `<option value="S${s + 1}">S${s + 1}</option>`;
          }
          sel.value = val;
        });
      }

      // ★ 관통 구멍 수 변경 — 모든 이벤트 유형 등록
      buildThroughHoleInputs(0);
      let _lastThCount = 0;
      function onThroughHoleCountChange() {
        const n = Math.min(Math.max(parseInt(throughHoleCountInput.value) || 0, 0), 10);
        if (n === _lastThCount) return;
        _lastThCount = n;
        throughHoleCountInput.value = n;
        buildThroughHoleInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        throughHoleCountInput.addEventListener(evt, onThroughHoleCountChange);
      });

      // ── 체인스프라켓(스프라켓) 동적 입력 빌더 ──
      // RS 체인 규격별 피치 (mm)
      const RS_PITCH = { RS25: 6.35, RS35: 9.525, RS40: 12.7, RS50: 15.875, RS60: 19.05, RS80: 25.4, RS100: 31.75, RS120: 38.1 };

      function buildChainGearInputs(cgCount) {
        chainGearInputsDiv.innerHTML = '';
        const secCount = parseInt(countInput.value) || 0;
        const firstSec = 'S1';
        const lastSec = `S${secCount}`;

        for (let k = 0; k < cgCount; k++) {
          const block = document.createElement('div');
          block.style.cssText = 'background:#1e2230; border:1px solid #f97316; border-radius:8px; padding:12px;';

          // 구간 선택: S1, S1~S2, S2~S3, ..., SN 형태
          let secOptions = '';
          if (secCount > 0) {
            secOptions += `<option value="${firstSec}">${firstSec} (첫번째)</option>`;
            for (let si = 1; si < secCount; si++) {
              const val = `S${si}~S${si+1}`;
              secOptions += `<option value="${val}">${val} (사이)</option>`;
            }
            if (secCount > 1) secOptions += `<option value="${lastSec}">${lastSec} (마지막)</option>`;
          }

          block.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#fb923c; font-weight:600;">⚙ 체인스프라켓 ${k + 1}</label>
              <select class="cg-sec" data-cg-idx="${k}" style="width:120px; padding:4px; background:#242836; border:1px solid #f97316; border-radius:6px; color:#fb923c; font-size:12px;">
                ${secOptions}
              </select>
              <span class="cg-side-display" data-cg-idx="${k}" style="font-size:11px; color:#94a3b8;">위치: 좌측</span>
            </div>

            <!-- 체인 규격 + 톱니수 -->
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">체인 규격</label>
                <select class="cg-chain-spec" data-cg-idx="${k}" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <option value="RS25">RS25 (P=6.35)</option>
                  <option value="RS35" selected>RS35 (P=9.525)</option>
                  <option value="RS40">RS40 (P=12.7)</option>
                  <option value="RS50">RS50 (P=15.875)</option>
                  <option value="RS60">RS60 (P=19.05)</option>
                  <option value="RS80">RS80 (P=25.4)</option>
                  <option value="RS100">RS100 (P=31.75)</option>
                  <option value="RS120">RS120 (P=38.1)</option>
                </select>
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">톱니수 (PT)</label>
                <input type="number" class="cg-teeth" data-cg-idx="${k}" value="9" min="5" max="200"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
            </div>

            <!-- 외경 + 내경(보어) -->
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">외경 Do (mm)</label>
                <input type="number" class="cg-outer-diam" data-cg-idx="${k}" placeholder="예: 31" step="0.1"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">내경 D (보어, mm)</label>
                <input type="number" class="cg-bore-diam" data-cg-idx="${k}" placeholder="예: 12" step="0.1"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
            </div>

            <!-- 기어 폭(두께) -->
            <div style="margin-bottom:6px;">
              <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">기어 두께 (mm)</label>
              <input type="number" class="cg-width" data-cg-idx="${k}" placeholder="예: 8" step="0.1"
                style="width:100px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
            </div>

            <!-- 키 유무 -->
            <div style="margin-bottom:6px;">
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                <input type="checkbox" class="cg-key-check" data-cg-idx="${k}">
                <span style="font-size:11px; color:#93c5fd;">키홈 있음</span>
              </label>
              <div class="cg-key-inputs" data-cg-idx="${k}" style="display:none; margin-top:4px; display:none;">
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px;">
                  <div>
                    <label style="font-size:9px; color:#6b7280;">키 폭 (mm)</label>
                    <input type="number" class="cg-key-w" data-cg-idx="${k}" placeholder="폭" step="0.1"
                      style="width:100%; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#e2e8f0; font-size:11px;">
                  </div>
                  <div>
                    <label style="font-size:9px; color:#6b7280;">키 높이 (mm)</label>
                    <input type="number" class="cg-key-h" data-cg-idx="${k}" placeholder="높이" step="0.1"
                      style="width:100%; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#e2e8f0; font-size:11px;">
                  </div>
                  <div>
                    <label style="font-size:9px; color:#6b7280;">키 깊이 (mm)</label>
                    <input type="number" class="cg-key-d" data-cg-idx="${k}" placeholder="깊이" step="0.1"
                      style="width:100%; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#e2e8f0; font-size:11px;">
                  </div>
                </div>
              </div>
            </div>

            <!-- 보스 유무 -->
            <div style="margin-bottom:6px;">
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                <input type="checkbox" class="cg-boss-check" data-cg-idx="${k}">
                <span style="font-size:11px; color:#a78bfa;">보스(boss) 있음</span>
              </label>
              <div class="cg-boss-inputs" data-cg-idx="${k}" style="display:none; margin-top:4px;">
                <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap;">
                  <label style="font-size:9px; color:#6b7280;">보스 갯수</label>
                  <input type="number" class="cg-boss-count" data-cg-idx="${k}" value="1" min="1" max="5"
                    style="width:50px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#e2e8f0; font-size:11px; text-align:center;">
                  <label style="font-size:9px; color:#6b7280; margin-left:8px;">보스 위치</label>
                  <select class="cg-boss-dir" data-cg-idx="${k}" style="width:80px; padding:4px; background:#242836; border:1px solid #a78bfa; border-radius:4px; color:#a78bfa; font-size:11px;">
                    <option value="left">좌측</option>
                    <option value="right">우측</option>
                  </select>
                </div>
                <div style="font-size:9px; color:#6b7280; margin-bottom:6px;">* 보스 1이 스프라켓에 가장 가까움 (스프라켓→보스1→보스2→...→축끝)</div>
                <div class="cg-boss-detail-container" data-cg-idx="${k}" style="display:grid; gap:6px;"></div>
              </div>
            </div>

            <!-- 보조투상도 -->
            <div style="margin-top:4px; border-top:1px solid #333; padding-top:4px;">
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                <input type="checkbox" class="cg-aux-view" data-cg-idx="${k}" checked>
                <span style="font-size:11px; color:#6b7280;">보조투상도 (톱니 형상) 그리기</span>
              </label>
            </div>
          `;
          chainGearInputsDiv.appendChild(block);

          // 이벤트 바인딩: 구간 선택 시 좌측/우측 자동 설정
          const secSel = block.querySelector(`.cg-sec[data-cg-idx="${k}"]`);
          const sideDisp = block.querySelector(`.cg-side-display[data-cg-idx="${k}"]`);
          function updateSide() {
            const val = secSel.value;
            if (val === firstSec) {
              sideDisp.textContent = '위치: 좌측 끝';
            } else if (val === lastSec) {
              sideDisp.textContent = '위치: 우측 끝';
            } else if (val.includes('~')) {
              sideDisp.textContent = `위치: ${val} 사이`;
            }
          }
          secSel.addEventListener('change', updateSide);
          updateSide();

          // 키홈 체크박스 토글
          const keyCheck = block.querySelector(`.cg-key-check[data-cg-idx="${k}"]`);
          const keyInputs = block.querySelector(`.cg-key-inputs[data-cg-idx="${k}"]`);
          keyCheck.addEventListener('change', () => {
            keyInputs.style.display = keyCheck.checked ? 'block' : 'none';
          });

          // 보스 체크박스 토글
          const bossCheck = block.querySelector(`.cg-boss-check[data-cg-idx="${k}"]`);
          const bossInputs = block.querySelector(`.cg-boss-inputs[data-cg-idx="${k}"]`);
          const bossCountInput = block.querySelector(`.cg-boss-count[data-cg-idx="${k}"]`);
          const bossDetailContainer = block.querySelector(`.cg-boss-detail-container[data-cg-idx="${k}"]`);

          function buildBossDetails(cgIdx, bCount) {
            bossDetailContainer.innerHTML = '';
            for (let b = 0; b < bCount; b++) {
              const bossBlock = document.createElement('div');
              bossBlock.style.cssText = 'background:#262a3a; border:1px solid #7c3aed; border-radius:6px; padding:8px;';
              bossBlock.innerHTML = `
                <div style="font-size:10px; color:#a78bfa; font-weight:600; margin-bottom:4px;">보스 ${b + 1}</div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px; margin-bottom:4px;">
                  <div>
                    <label style="font-size:9px; color:#6b7280;">보스 외경 (mm)</label>
                    <input type="number" class="cg-boss-outer" data-cg-idx="${cgIdx}" data-boss-idx="${b}" placeholder="예: 20" step="0.1"
                      style="width:100%; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#e2e8f0; font-size:11px;">
                  </div>
                  <div>
                    <label style="font-size:9px; color:#6b7280;">보스 두께 (mm)</label>
                    <input type="number" class="cg-boss-thick" data-cg-idx="${cgIdx}" data-boss-idx="${b}" placeholder="예: 5" step="0.1"
                      style="width:100%; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:4px; color:#e2e8f0; font-size:11px;">
                  </div>
                </div>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; margin-bottom:4px;">
                  <input type="checkbox" class="cg-boss-r-check" data-cg-idx="${cgIdx}" data-boss-idx="${b}">
                  <span style="font-size:10px; color:#fbbf24;">R값(필릿) 적용</span>
                </label>
                <div class="cg-boss-r-inputs" data-cg-idx="${cgIdx}" data-boss-idx="${b}" style="display:none;">
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px;">
                    <div>
                      <label style="font-size:9px; color:#6b7280;">R값 (mm)</label>
                      <input type="number" class="cg-boss-r-val" data-cg-idx="${cgIdx}" data-boss-idx="${b}" placeholder="예: 2" step="0.1"
                        style="width:100%; padding:4px; background:#242836; border:1px solid #554a20; border-radius:4px; color:#fbbf24; font-size:11px;">
                    </div>
                    <div>
                      <label style="font-size:9px; color:#6b7280;">R 적용 위치</label>
                      <select class="cg-boss-r-side" data-cg-idx="${cgIdx}" data-boss-idx="${b}" style="width:100%; padding:4px; background:#242836; border:1px solid #554a20; border-radius:4px; color:#fbbf24; font-size:11px;">
                        <option value="both">양쪽</option>
                        <option value="left">좌측</option>
                        <option value="right">우측</option>
                      </select>
                    </div>
                  </div>
                  <div style="font-size:9px; color:#6b7280; margin-top:2px;">* 좌/우 = 보스 정면도 좌·우측 상하 모서리</div>
                </div>
              `;
              bossDetailContainer.appendChild(bossBlock);

              // R값 토글
              const rChk = bossBlock.querySelector(`.cg-boss-r-check[data-boss-idx="${b}"]`);
              const rIn = bossBlock.querySelector(`.cg-boss-r-inputs[data-boss-idx="${b}"]`);
              rChk.addEventListener('change', () => { rIn.style.display = rChk.checked ? 'block' : 'none'; });
            }
          }

          bossCheck.addEventListener('change', () => {
            bossInputs.style.display = bossCheck.checked ? 'block' : 'none';
            if (bossCheck.checked) buildBossDetails(k, parseInt(bossCountInput.value) || 1);
          });

          ['input', 'change'].forEach(evt => {
            bossCountInput.addEventListener(evt, () => {
              const bc = Math.min(Math.max(parseInt(bossCountInput.value) || 1, 1), 5);
              bossCountInput.value = bc;
              buildBossDetails(k, bc);
            });
          });
        }
      }

      function updateChainGearSelects(secCount) {
        const firstSec = 'S1';
        const lastSec = `S${secCount}`;
        chainGearInputsDiv.querySelectorAll('.cg-sec').forEach(sel => {
          const val = sel.value;
          sel.innerHTML = '';
          if (secCount > 0) sel.innerHTML += `<option value="${firstSec}">${firstSec} (첫번째)</option>`;
          for (let si = 1; si < secCount; si++) {
            const bv = `S${si}~S${si+1}`;
            sel.innerHTML += `<option value="${bv}">${bv} (사이)</option>`;
          }
          if (secCount > 1) sel.innerHTML += `<option value="${lastSec}">${lastSec} (마지막)</option>`;
          // 이전 값 복원 시도
          if ([...sel.options].some(o => o.value === val)) sel.value = val;
        });
      }

      buildChainGearInputs(0);
      let _lastCgCount = 0;
      function onChainGearCountChange() {
        const n = Math.min(Math.max(parseInt(chainGearCountInput.value) || 0, 0), 2);
        if (n === _lastCgCount) return;
        _lastCgCount = n;
        chainGearCountInput.value = n;
        buildChainGearInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        chainGearCountInput.addEventListener(evt, onChainGearCountChange);
      });

      // ══════════════════════════════════════════════════════════
      // ★ 파라미터 수정 모드: prefillData → 폼 값 자동 채우기
      // ══════════════════════════════════════════════════════════
      if (prefillData) {
        (function applyPrefill(pd) {
          // 기본 정보
          if (pd.paperSize) { const el = document.getElementById('paramPaperSize'); if (el) el.value = pd.paperSize; }
          if (pd.material) { const el = document.getElementById('paramMaterial'); if (el) el.value = pd.material; }
          if (pd.totalLength) { const el = document.getElementById('paramTotalLength'); if (el) el.value = pd.totalLength; }
          if (pd.partName) { const el = document.getElementById('paramPartName'); if (el) el.value = pd.partName; }
          if (pd.scale) { const el = document.getElementById('paramScale'); if (el) el.value = pd.scale; }
          if (pd.projectionMethod) { const el = document.getElementById('paramProjection'); if (el) el.value = pd.projectionMethod; }

          // 축 유형
          if (pd.shaftType === 'hollow') btnHollow.click();

          // 구간 수 + 구간별 데이터
          const secCount = pd._sectionCount || pd.sections?.length || 3;
          countInput.value = secCount;
          buildSectionInputs(secCount);
          _lastSecCount = secCount;

          if (pd.sections) {
            pd.sections.forEach((sec, i) => {
              const lenEl = sectionInputsDiv.querySelector(`.sec-length[data-idx="${i}"]`);
              const diamEl = sectionInputsDiv.querySelector(`.sec-diameter[data-idx="${i}"]`);
              if (lenEl && sec.length) lenEl.value = sec.length;
              if (diamEl && sec.diameter) diamEl.value = sec.diameter;
              // ★ v114: 프로파일 타입 prefill
              if (sec.profile === 'TAPER') {
                const profEl = sectionInputsDiv.querySelector(`.sec-profile[data-idx="${i}"]`);
                const deEl = sectionInputsDiv.querySelector(`.sec-diameter-end[data-idx="${i}"]`);
                if (profEl) { profEl.value = 'TAPER'; profEl.dispatchEvent(new Event('change')); }
                if (deEl && sec.diameterEnd) deEl.value = sec.diameterEnd;
              }
              // ★ v111: 모따기 prefill
              if (sec.chamferLeft > 0) {
                const chk = sectionInputsDiv.querySelector(`.sec-chamfer-left[data-idx="${i}"]`);
                const val = sectionInputsDiv.querySelector(`.sec-chamfer-left-val[data-idx="${i}"]`);
                if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
                if (val) val.value = sec.chamferLeft;
              }
              if (sec.chamferRight > 0) {
                const chk = sectionInputsDiv.querySelector(`.sec-chamfer-right[data-idx="${i}"]`);
                const val = sectionInputsDiv.querySelector(`.sec-chamfer-right-val[data-idx="${i}"]`);
                if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
                if (val) val.value = sec.chamferRight;
              }
            });
          }

          // 중공축 내경
          if (pd.hollowBoreDiam) {
            const el = document.getElementById('paramHollowBoreDiam');
            if (el) el.value = pd.hollowBoreDiam;
          }
          updateHollowOuterDiam();

          // TAP 좌측
          if (pd.leftTapType) {
            const el = document.getElementById('paramLeftTapType'); if (el) el.value = pd.leftTapType;
          }
          if (pd.leftTap) {
            const el = document.getElementById('paramLeftTap'); if (el) el.value = pd.leftTap;
          }
          if (pd.leftTapDepth) {
            const el = document.getElementById('paramLeftTapDepth'); if (el) el.value = pd.leftTapDepth;
          }
          // v176: 피치 옵션 먼저 빌드 후 선택값 복원
          _updateTapPitchOptions('Left');
          if (pd.leftTapPitch != null) {
            const pEl = document.getElementById('paramLeftTapPitch');
            if (pEl) pEl.value = pd.leftTapPitch;
          }
          if (pd.leftCB) {
            const chk = document.getElementById('paramLeftCB');
            if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
            const dEl = document.getElementById('paramLeftCBDiam'); if (dEl && pd.leftCB.diameter) dEl.value = pd.leftCB.diameter;
            const dpEl = document.getElementById('paramLeftCBDepth'); if (dpEl && pd.leftCB.depth) dpEl.value = pd.leftCB.depth;
          }
          // TAP 우측
          if (pd.rightTapType) {
            const el = document.getElementById('paramRightTapType'); if (el) el.value = pd.rightTapType;
          }
          if (pd.rightTap) {
            const el = document.getElementById('paramRightTap'); if (el) el.value = pd.rightTap;
          }
          if (pd.rightTapDepth) {
            const el = document.getElementById('paramRightTapDepth'); if (el) el.value = pd.rightTapDepth;
          }
          // v176: 피치 옵션 먼저 빌드 후 선택값 복원
          _updateTapPitchOptions('Right');
          if (pd.rightTapPitch != null) {
            const pEl = document.getElementById('paramRightTapPitch');
            if (pEl) pEl.value = pd.rightTapPitch;
          }
          if (pd.rightCB) {
            const chk = document.getElementById('paramRightCB');
            if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
            const dEl = document.getElementById('paramRightCBDiam'); if (dEl && pd.rightCB.diameter) dEl.value = pd.rightCB.diameter;
            const dpEl = document.getElementById('paramRightCBDepth'); if (dpEl && pd.rightCB.depth) dpEl.value = pd.rightCB.depth;
          }

          // 키홈 (v178: KS B 1311 자동 규격 + 길이 L 분리)
          if (pd.keyways && pd.keyways.length > 0) {
            keywayCountInput.value = pd.keyways.length;
            buildKeywayInputs(pd.keyways.length);
            pd.keyways.forEach((kw, k) => {
              const sel = keywayInputsDiv.querySelector(`.kw-sec[data-kw-idx="${k}"]`); if (sel && kw.section) sel.value = kw.section;
              const dirEl = keywayInputsDiv.querySelector(`.kw-dir[data-kw-idx="${k}"]`); if (dirEl && kw.direction) dirEl.value = kw.direction;
              const shpEl = keywayInputsDiv.querySelector(`.kw-shape[data-kw-idx="${k}"]`); if (shpEl && kw.shape) shpEl.value = kw.shape;
              // v178: 구간 선택 후 KS 규격 자동 조회 (b, h, t1)
              _refreshKeywayKS(k);
              // v178: 길이 L 복원
              const lenEl = keywayInputsDiv.querySelector(`.kw-len[data-kw-idx="${k}"]`); if (lenEl && kw.width) lenEl.value = kw.width;
              // 좌측 이격 복원
              const loEl = keywayInputsDiv.querySelector(`.kw-left-off[data-kw-idx="${k}"]`); if (loEl && kw.leftOffset != null) loEl.value = kw.leftOffset;
              // 우측 오프셋 자동 재계산
              _updateKeywayRightOffset(k);
            });
          }

          // 스냅링
          if (pd.snapRings && pd.snapRings.length > 0) {
            snapRingCountInput.value = pd.snapRings.length;
            buildSnapRingInputs(pd.snapRings.length);
            pd.snapRings.forEach((sr, k) => {
              const sel = snapRingInputsDiv.querySelector(`.sr-sec[data-sr-idx="${k}"]`); if (sel && sr.section) sel.value = sr.section;
              const loEl = snapRingInputsDiv.querySelector(`.sr-left-off[data-sr-idx="${k}"]`); if (loEl && sr.leftOffset != null) loEl.value = sr.leftOffset;
              // 구간 선택 → 자동/수동 상태 재구성 (자동값 계산)
              refreshSnapRingBlock(k);
              // 수동 모드(규격 외)일 때만 저장된 외경·두께 복원
              const blk = snapRingInputsDiv.querySelector(`.sr-block[data-sr-idx="${k}"]`);
              if (blk && blk.getAttribute('data-sr-mode') === 'manual') {
                const dEl = blk.querySelector('.sr-diam'); if (dEl && sr.diam) dEl.value = sr.diam;
                const tEl = blk.querySelector('.sr-thick'); if (tEl && sr.thickness) tEl.value = sr.thickness;
              }
              // 우측 오프셋 재계산
              _updateSnapRingRightOffset(k);
            });
          }

          // 관통 구멍
          if (pd.throughHoles && pd.throughHoles.length > 0) {
            throughHoleCountInput.value = pd.throughHoles.length;
            buildThroughHoleInputs(pd.throughHoles.length);
            pd.throughHoles.forEach((th, k) => {
              const sel = throughHoleInputsDiv.querySelector(`.th-sec[data-th-idx="${k}"]`); if (sel && th.section) sel.value = th.section;
              const dEl = throughHoleInputsDiv.querySelector(`.th-diam[data-th-idx="${k}"]`); if (dEl && th.diameter) dEl.value = th.diameter;
              const oEl = throughHoleInputsDiv.querySelector(`.th-offset[data-th-idx="${k}"]`); if (oEl && th.offset != null) oEl.value = th.offset;
              // 우측 오프셋 자동 재계산
              _updateThroughHoleRightOffset(k);
            });
          }

          // 베어링(깊은 홈 볼베어링) — v158: 저장/복원 누락 버그 수정
          if (pd.bearings && pd.bearings.length > 0) {
            bearingCountInput.value = pd.bearings.length;
            _lastBrCount = pd.bearings.length;
            buildBearingInputs(pd.bearings.length);
            pd.bearings.forEach((br, k) => {
              const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);
              if (!block) return;
              // 1) 구간 선택
              const secSel = block.querySelector('.br-sec');
              if (secSel && br.section) secSel.value = br.section;
              // 2) 호칭번호 입력 → refreshBearingBlock 이 규격표에서 d/D/B/r 재조회 + data 속성 재설정
              const desigEl = block.querySelector('.br-desig');
              if (desigEl && br.designation) desigEl.value = br.designation;
              // 3) 좌측 오프셋 복원
              const loEl = block.querySelector('.br-left-off');
              if (loEl && br.leftOffset != null) loEl.value = br.leftOffset;
              // 4) 규격 재조회 (d/D/B/r 및 data-br-* 속성, 축지름 일치검사 재구성)
              refreshBearingBlock(k);
              // 5) 규격표에 없는 호칭이면(수동) 저장된 원본 치수를 data 속성으로 직접 복원
              if (block.getAttribute('data-br-fit') === 'invalid' && br.outer > 0 && br.width > 0) {
                block.setAttribute('data-br-D', br.outer);
                block.setAttribute('data-br-d', br.bore);
                block.setAttribute('data-br-B', br.width);
                block.setAttribute('data-br-r', br.fillet || 0);
                block.setAttribute('data-br-fit', br.forcedFit ? 'forced' : 'ok');
              }
              // 6) 우측 오프셋 재계산
              if (typeof _updateBearingRightOffset === 'function') _updateBearingRightOffset(k);
            });
          }

          // 체인스프라켓
          if (pd.chainGears && pd.chainGears.length > 0) {
            chainGearCountInput.value = pd.chainGears.length;
            buildChainGearInputs(pd.chainGears.length);
            _lastCgCount = pd.chainGears.length;
            pd.chainGears.forEach((cg, k) => {
              const sel = chainGearInputsDiv.querySelector(`.cg-sec[data-cg-idx="${k}"]`);
              if (sel) {
                if (cg.placement === 'between' && cg.sectionLeft && cg.sectionRight) {
                  sel.value = `${cg.sectionLeft}~${cg.sectionRight}`;
                } else if (cg.section) {
                  sel.value = cg.section;
                }
                // side display 업데이트 트리거
                sel.dispatchEvent(new Event('change'));
              }
              const specSel = chainGearInputsDiv.querySelector(`.cg-chain-spec[data-cg-idx="${k}"]`); if (specSel && cg.chainSpec) specSel.value = cg.chainSpec;
              const tEl = chainGearInputsDiv.querySelector(`.cg-teeth[data-cg-idx="${k}"]`); if (tEl && cg.teeth) tEl.value = cg.teeth;
              const oEl = chainGearInputsDiv.querySelector(`.cg-outer-diam[data-cg-idx="${k}"]`); if (oEl && cg.outerDiam) oEl.value = cg.outerDiam;
              const bEl = chainGearInputsDiv.querySelector(`.cg-bore-diam[data-cg-idx="${k}"]`); if (bEl && cg.boreDiam) bEl.value = cg.boreDiam;
              const wEl = chainGearInputsDiv.querySelector(`.cg-width[data-cg-idx="${k}"]`); if (wEl && cg.gearWidth) wEl.value = cg.gearWidth;

              // 키홈
              if (cg.key) {
                const kChk = chainGearInputsDiv.querySelector(`.cg-key-check[data-cg-idx="${k}"]`);
                if (kChk) { kChk.checked = true; kChk.dispatchEvent(new Event('change')); }
                const kwEl = chainGearInputsDiv.querySelector(`.cg-key-w[data-cg-idx="${k}"]`); if (kwEl) kwEl.value = cg.key.width || '';
                const khEl = chainGearInputsDiv.querySelector(`.cg-key-h[data-cg-idx="${k}"]`); if (khEl) khEl.value = cg.key.height || '';
                const kdEl = chainGearInputsDiv.querySelector(`.cg-key-d[data-cg-idx="${k}"]`); if (kdEl) kdEl.value = cg.key.depth || '';
              }

              // 보스
              if (cg.boss) {
                const bChk = chainGearInputsDiv.querySelector(`.cg-boss-check[data-cg-idx="${k}"]`);
                if (bChk) { bChk.checked = true; bChk.dispatchEvent(new Event('change')); }
                const bcEl = chainGearInputsDiv.querySelector(`.cg-boss-count[data-cg-idx="${k}"]`);
                if (bcEl) {
                  bcEl.value = cg.boss.count || 1;
                  bcEl.dispatchEvent(new Event('change'));
                }
                // per-boss 데이터
                const bossList = cg.boss.bosses || [{ outerDiam: cg.boss.outerDiam, thickness: cg.boss.thickness, fillet: cg.boss.fillet }];
                setTimeout(() => {
                  bossList.forEach((bd, b) => {
                    const boEl = chainGearInputsDiv.querySelector(`.cg-boss-outer[data-cg-idx="${k}"][data-boss-idx="${b}"]`);
                    if (boEl && bd.outerDiam) boEl.value = bd.outerDiam;
                    const btEl = chainGearInputsDiv.querySelector(`.cg-boss-thick[data-cg-idx="${k}"][data-boss-idx="${b}"]`);
                    if (btEl && bd.thickness) btEl.value = bd.thickness;
                    if (bd.fillet && bd.fillet.value > 0) {
                      const rChk = chainGearInputsDiv.querySelector(`.cg-boss-r-check[data-cg-idx="${k}"][data-boss-idx="${b}"]`);
                      if (rChk) { rChk.checked = true; rChk.dispatchEvent(new Event('change')); }
                      const rvEl = chainGearInputsDiv.querySelector(`.cg-boss-r-val[data-cg-idx="${k}"][data-boss-idx="${b}"]`);
                      if (rvEl) rvEl.value = bd.fillet.value;
                      const rsEl = chainGearInputsDiv.querySelector(`.cg-boss-r-side[data-cg-idx="${k}"][data-boss-idx="${b}"]`);
                      if (rsEl) rsEl.value = bd.fillet.side || 'both';
                    }
                  });
                }, 50);
              }

              // 보스 위치(좌/우) 복원
              const bossDirSel = chainGearInputsDiv.querySelector(`.cg-boss-dir[data-cg-idx="${k}"]`);
              if (bossDirSel && cg.bossDirection) bossDirSel.value = cg.bossDirection;

              // 보조투상도 체크박스 복원
              const auxChk = chainGearInputsDiv.querySelector(`.cg-aux-view[data-cg-idx="${k}"]`);
              if (auxChk) auxChk.checked = cg.auxView !== false;

              // side display 업데이트
              const sideDisp = chainGearInputsDiv.querySelector(`.cg-side-display[data-cg-idx="${k}"]`);
              if (sideDisp) sideDisp.textContent = cg.side === 'left' ? '위치: 좌측' : '위치: 우측';
            });
          }

          console.log('[ImageAnalyzer] Prefill applied:', pd);
        })(prefillData);
      }

      // ── 스텝 전환 로직 ──
      const wizStep1 = document.getElementById('wizStep1');
      const wizStep2 = document.getElementById('wizStep2');
      const wizInd1 = document.getElementById('wizInd1');
      const wizInd2 = document.getElementById('wizInd2');
      const modalScrollBox = overlay.querySelector('div'); // 스크롤 컨테이너

      function goToStep(step) {
        if (step === 1) {
          wizStep1.style.display = '';
          wizStep2.style.display = 'none';
          // 인디케이터 갱신
          wizInd1.style.background = '#1e3a5f';
          wizInd1.style.borderColor = '#3b82f6';
          wizInd1.querySelector('span:first-child').style.background = '#3b82f6';
          wizInd1.querySelector('span:first-child').style.color = 'white';
          wizInd1.querySelector('span:last-child').style.color = '#93c5fd';
          wizInd2.style.background = '#242836';
          wizInd2.style.borderColor = '#3b3f51';
          wizInd2.querySelector('span:first-child').style.background = '#3b3f51';
          wizInd2.querySelector('span:first-child').style.color = '#6b7280';
          wizInd2.querySelector('span:last-child').style.color = '#6b7280';
        } else {
          wizStep1.style.display = 'none';
          wizStep2.style.display = '';
          // 인디케이터 갱신
          wizInd1.style.background = '#0f2a1a';
          wizInd1.style.borderColor = '#059669';
          wizInd1.querySelector('span:first-child').style.background = '#059669';
          wizInd1.querySelector('span:first-child').style.color = 'white';
          wizInd1.querySelector('span:last-child').style.color = '#34d399';
          wizInd2.style.background = '#1e3a5f';
          wizInd2.style.borderColor = '#3b82f6';
          wizInd2.querySelector('span:first-child').style.background = '#3b82f6';
          wizInd2.querySelector('span:first-child').style.color = 'white';
          wizInd2.querySelector('span:last-child').style.color = '#93c5fd';
        }
        // 스크롤 맨 위로
        if (modalScrollBox) modalScrollBox.scrollTop = 0;
      }

      // "다음" 버튼 (Step 1 → Step 2)
      document.getElementById('paramBtnNext').addEventListener('click', () => {
        // 구간 수 유효성 검사
        const cnt = parseInt(countInput.value) || 0;
        if (cnt < 1) {
          alert('구간 수를 1개 이상 입력해주세요.');
          return;
        }
        goToStep(2);
      });

      // "이전" 버튼 (Step 2 → Step 1)
      document.getElementById('paramBtnPrev').addEventListener('click', () => {
        goToStep(1);
      });

      // Step1 취소
      document.getElementById('paramBtnCancelStep1').addEventListener('click', () => {
        overlay.remove();
        reject(new Error('사용자가 취소했습니다'));
      });

      // Step2 취소
      document.getElementById('paramBtnCancel').addEventListener('click', () => {
        overlay.remove();
        reject(new Error('사용자가 취소했습니다'));
      });

      // 도면 생성 (Step 2)
      document.getElementById('paramBtnGenerate').addEventListener('click', () => {
        const signals = collectFormData();
        if (!signals) return;
        overlay.remove();
        resolve(signals);
      });

      /**
       * 폼 데이터 수집 → signals 형식 변환
       */
      function collectFormData() {
        const CONF = AIEngine.CONF;
        const count = parseInt(countInput.value);
        const totalLength = parseFloat(document.getElementById('paramTotalLength').value) || null;
        const material = document.getElementById('paramMaterial').value.trim() || null;
        const shaftType = document.getElementById('paramShaftType').value; // 'solid' or 'hollow'
        const paperSize = document.getElementById('paramPaperSize').value || 'A3';
        const partName = document.getElementById('paramPartName').value.trim() || null;
        const scaleStr = document.getElementById('paramScale').value.trim() || '1:1';
        const projectionMethod = document.getElementById('paramProjection').value || '3각법';

        // 구간별 데이터
        const segmentLengths = [];
        const allDiameters = [];
        let hasError = false;

        // ★ v111: 구간별 모따기(chamfer) 데이터 수집
        const sectionChamfers = [];

        for (let i = 0; i < count; i++) {
          const lenEl = sectionInputsDiv.querySelector(`.sec-length[data-idx="${i}"]`);
          const diamEl = sectionInputsDiv.querySelector(`.sec-diameter[data-idx="${i}"]`);
          const len = parseFloat(lenEl?.value);
          const diam = parseFloat(diamEl?.value);

          if (!len || len <= 0) {
            lenEl.style.borderColor = '#ef4444';
            hasError = true;
          } else {
            lenEl.style.borderColor = '#3b3f51';
          }

          segmentLengths.push({
            value: len || null,
            confidence: CONF.CONFIRMED,
            position: `S${i + 1}`,
          });

          // ★ v114: 프로파일 타입 + 끝직경 (TAPER)
          const profileEl = sectionInputsDiv.querySelector(`.sec-profile[data-idx="${i}"]`);
          const diamEndEl = sectionInputsDiv.querySelector(`.sec-diameter-end[data-idx="${i}"]`);
          const profile = profileEl?.value || 'CYLINDER';
          const diamEnd = parseFloat(diamEndEl?.value) || null;

          allDiameters.push({
            section: `S${i + 1}`,
            value: diam || null,
            // v114: 테이퍼인 경우 끝직경 추가
            valueDiamEnd: (profile === 'TAPER') ? (diamEnd || diam || null) : null,
            profile: profile,
            confidence: diam ? CONF.CONFIRMED : CONF.UNCERTAIN,
          });

          // v111: 모따기 데이터
          const chkL = sectionInputsDiv.querySelector(`.sec-chamfer-left[data-idx="${i}"]`);
          const valL = sectionInputsDiv.querySelector(`.sec-chamfer-left-val[data-idx="${i}"]`);
          const chkR = sectionInputsDiv.querySelector(`.sec-chamfer-right[data-idx="${i}"]`);
          const valR = sectionInputsDiv.querySelector(`.sec-chamfer-right-val[data-idx="${i}"]`);
          sectionChamfers.push({
            section: `S${i + 1}`,
            left: chkL?.checked ? (parseFloat(valL?.value) || 1) : 0,
            right: chkR?.checked ? (parseFloat(valR?.value) || 1) : 0,
          });
        }

        if (hasError) {
          alert('모든 구간의 길이를 입력해주세요.');
          return null;
        }

        // 직경 그룹화 (같은 직경은 하나로)
        const diameterGroups = {};
        allDiameters.forEach(d => {
          if (d.value == null) return;
          const key = d.value;
          if (!diameterGroups[key]) {
            diameterGroups[key] = {
              value: d.value,
              confidence: d.confidence,
              segments: [],
            };
          }
          diameterGroups[key].segments.push(d.section);
        });
        const diameters = Object.values(diameterGroups);

        // Hidden features (TAP + 키홈)
        const hiddenFeatures = [];
        const tapSpecs = [];

        // 좌측 TAP
        const leftTap = document.getElementById('paramLeftTap').value.trim();
        const leftTapDepth = parseFloat(document.getElementById('paramLeftTapDepth').value);
        const leftTapType = document.getElementById('paramLeftTapType')?.value || '';    // v176: 나사 종류
        const leftTapPitch = parseFloat(document.getElementById('paramLeftTapPitch')?.value); // v176: 피치
        const leftCBChecked = document.getElementById('paramLeftCB')?.checked;
        const leftCBDiam = parseFloat(document.getElementById('paramLeftCBDiam')?.value);
        const leftCBDepth = parseFloat(document.getElementById('paramLeftCBDepth')?.value);
        if (leftTap) {
          const tapDiam = parseInt(leftTap.replace(/[^\d]/g, '')) || 10;
          const hfObj = {
            id: 'HF_TAP_L',
            section: 'S1',
            type: 'tap-bore',
            diameter: tapDiam,
            depth: leftTapDepth || 30,
            side: 'left',
            confidence: CONF.CONFIRMED,
            threadType: leftTapType || 'coarse',   // v176: 보통/가는
            pitch: !isNaN(leftTapPitch) ? leftTapPitch : null,  // v176: 선택된 피치
          };
          // 카운터보어
          if (leftCBChecked && leftCBDiam > 0 && leftCBDepth > 0) {
            hfObj.counterBore = { diameter: leftCBDiam, depth: leftCBDepth };
          }
          hiddenFeatures.push(hfObj);
          // v176: 피치 정보 포함 specStr
          let pitchStr = hfObj.pitch ? `×${hfObj.pitch}` : '';
          let typeLabel = hfObj.threadType === 'fine' ? ' (가는나사)' : '';
          let specStr = `${leftTap}${pitchStr} TAP${leftTapDepth ? ' 깊이' + leftTapDepth : ''}${typeLabel}`;
          tapSpecs.push({
            holeId: 'HF_TAP_L',
            section: 'S1',
            spec: specStr,
            specConf: CONF.CONFIRMED,
            counterBore: hfObj.counterBore || null,
          });
        }

        // 우측 TAP
        const rightTap = document.getElementById('paramRightTap').value.trim();
        const rightTapDepth = parseFloat(document.getElementById('paramRightTapDepth').value);
        const rightTapType = document.getElementById('paramRightTapType')?.value || '';   // v176: 나사 종류
        const rightTapPitch = parseFloat(document.getElementById('paramRightTapPitch')?.value); // v176: 피치
        const rightCBChecked = document.getElementById('paramRightCB')?.checked;
        const rightCBDiam = parseFloat(document.getElementById('paramRightCBDiam')?.value);
        const rightCBDepth = parseFloat(document.getElementById('paramRightCBDepth')?.value);
        if (rightTap) {
          const tapDiam = parseInt(rightTap.replace(/[^\d]/g, '')) || 10;
          const lastSec = `S${count}`;
          const hfObj = {
            id: 'HF_TAP_R',
            section: lastSec,
            type: 'tap-bore',
            diameter: tapDiam,
            depth: rightTapDepth || 30,
            side: 'right',
            confidence: CONF.CONFIRMED,
            threadType: rightTapType || 'coarse',  // v176: 보통/가는
            pitch: !isNaN(rightTapPitch) ? rightTapPitch : null, // v176: 선택된 피치
          };
          // 카운터보어
          if (rightCBChecked && rightCBDiam > 0 && rightCBDepth > 0) {
            hfObj.counterBore = { diameter: rightCBDiam, depth: rightCBDepth };
          }
          hiddenFeatures.push(hfObj);
          // v176: 피치 정보 포함 specStr
          let pitchStr = hfObj.pitch ? `×${hfObj.pitch}` : '';
          let typeLabel = hfObj.threadType === 'fine' ? ' (가는나사)' : '';
          let specStr = `${rightTap}${pitchStr} TAP${rightTapDepth ? ' 깊이' + rightTapDepth : ''}${typeLabel}`;
          tapSpecs.push({
            holeId: 'HF_TAP_R',
            section: lastSec,
            spec: specStr,
            specConf: CONF.CONFIRMED,
            counterBore: hfObj.counterBore || null,
          });
        }

        // ── 키홈 N개 동적 수집 ──
        const kwCount = parseInt(keywayCountInput.value) || 0;
        const auxiliaryViews = [];
        const auxPositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

        for (let k = 0; k < kwCount; k++) {
          const kwSec = keywayInputsDiv.querySelector(`.kw-sec[data-kw-idx="${k}"]`)?.value || '';
          // v178: KS B 1311 자동값 — b(폭), h(높이), t1(깊이)
          const kwB = parseFloat(keywayInputsDiv.querySelector(`.kw-w[data-kw-idx="${k}"]`)?.value);   // 키 폭 b (KS 자동)
          const kwH = parseFloat(keywayInputsDiv.querySelector(`.kw-h[data-kw-idx="${k}"]`)?.value);   // 키 높이 h (KS 자동)
          const kwD = parseFloat(keywayInputsDiv.querySelector(`.kw-d[data-kw-idx="${k}"]`)?.value);   // 키홈 깊이 t1 (KS 자동)
          // v178: 사용자 입력값 — 길이 L, 좌측 이격
          let kwLen = parseFloat(keywayInputsDiv.querySelector(`.kw-len[data-kw-idx="${k}"]`)?.value); // 키 길이 L
          const kwLeftOff = parseFloat(keywayInputsDiv.querySelector(`.kw-left-off[data-kw-idx="${k}"]`)?.value);
          const kwRightOff = parseFloat(keywayInputsDiv.querySelector(`.kw-right-off[data-kw-idx="${k}"]`)?.value);
          const kwDir = keywayInputsDiv.querySelector(`.kw-dir[data-kw-idx="${k}"]`)?.value || 'side';  // v116: 키 방향
          const kwShape = keywayInputsDiv.querySelector(`.kw-shape[data-kw-idx="${k}"]`)?.value || 'obround';  // v117: 키 형상

          // v178: keywayWidth는 길이(L) 사용 — 도면에서 키홈의 수평 범위 = L
          const kwW = kwLen;

          if (kwSec && kwW && kwW > 0) {
            hiddenFeatures.push({
              id: `HF_KW${k + 1}`,
              section: kwSec,
              type: 'keyway',
              keywayWidth: kwW,           // 키홈 길이 L (도면에서의 수평 범위)
              keywayHeight: kwH || 6,     // 키 높이 h (KS 자동)
              keywayDepth: kwD || 3.5,    // 키홈 깊이 t1 (KS 자동)
              keywayBreadth: kwB || 0,    // v178: 키 폭 b (KS 자동, 보조투상도용)
              keywayLeftOffset: isNaN(kwLeftOff) ? null : kwLeftOff,
              keywayRightOffset: isNaN(kwRightOff) ? null : kwRightOff,
              keywayDirection: kwDir,  // v116: 'front' 또는 'side'
              keywayShape: kwShape,    // v117: 'obround' | 'one-side-round' | 'rect'
              side: k % 2 === 0 ? 'left' : 'right',
              confidence: CONF.CONFIRMED,
            });
            // v116: 측면(side) 키홈만 보조투상도 생성 — 정면(front)은 메인 뷰에 직접 그림
            if (kwDir !== 'front') {
              auxiliaryViews.push({
                id: `AUX${k + 1}`,
                position: auxPositions[k % auxPositions.length],
                label: '',
                // v178: 보조투상도 shape — 길이(L) × 폭(b)
                shape: { type: kwShape || 'obround', width: kwW, height: kwB || 6, confidence: CONF.CONFIRMED },
                dimensions: [
                  { axis: 'horizontal', value: kwW, confidence: CONF.CONFIRMED },
                  { axis: 'vertical', value: kwB || 6, confidence: CONF.CONFIRMED },
                ],
                relatedSection: kwSec,
                projectionLines: true,
                keywayLeftOffset: isNaN(kwLeftOff) ? null : kwLeftOff,
                keywayRightOffset: isNaN(kwRightOff) ? null : kwRightOff,
              });
            }
          }
        }

        // ── 스냅링 데이터 수집 ──
        const srCount = parseInt(snapRingCountInput.value) || 0;
        console.log('[collectFormData] snapRing count:', srCount);
        for (let k = 0; k < srCount; k++) {
          const block = snapRingInputsDiv.querySelector(`.sr-block[data-sr-idx="${k}"]`);
          const srSec = block?.querySelector('.sr-sec')?.value || '';
          const srMode = block?.getAttribute('data-sr-mode') || 'none';

          // 외경·두께: 자동 모드는 KS 규격 자동값(블록 속성), 수동 모드는 입력값
          let srDiam, srThick;
          if (srMode === 'auto') {
            srDiam = parseFloat(block.getAttribute('data-sr-diam'));
            srThick = parseFloat(block.getAttribute('data-sr-thick'));
          } else {
            srDiam = parseFloat(block?.querySelector('.sr-diam')?.value);
            srThick = parseFloat(block?.querySelector('.sr-thick')?.value);
          }

          const srLeftOff = parseFloat(block?.querySelector('.sr-left-off')?.value);
          // 우측 오프셋: 축길이 − (두께 + 좌측 오프셋) 자동 계산 (이미 필드에 채워져 있음)
          let srRightOff = parseFloat(block?.querySelector('.sr-right-off')?.value);
          if (isNaN(srRightOff) && !isNaN(srLeftOff) && srThick > 0) {
            // 필드가 비어있으면 구간 길이로 직접 계산
            const secIdx = parseInt(String(srSec).replace(/^S/i, ''), 10) - 1;
            const lenEl = sectionInputsDiv.querySelector(`.sec-length[data-idx="${secIdx}"]`);
            const shaftLen = lenEl ? parseFloat(lenEl.value) : NaN;
            if (!isNaN(shaftLen)) srRightOff = Math.round((shaftLen - (srThick + srLeftOff)) * 100) / 100;
          }
          console.log(`[collectFormData] SR[${k}]: sec=${srSec}, mode=${srMode}, diam=${srDiam}, thick=${srThick}, leftOff=${srLeftOff}, rightOff=${srRightOff}`);

          if (srSec && srDiam > 0 && srThick > 0) {
            hiddenFeatures.push({
              id: `HF_SR${k + 1}`,
              section: srSec,
              type: 'snapring',
              snapRingDiam: srDiam,
              snapRingThickness: srThick,
              snapRingLeftOffset: isNaN(srLeftOff) ? null : srLeftOff,
              snapRingRightOffset: isNaN(srRightOff) ? null : srRightOff,
              confidence: CONF.CONFIRMED,
            });
          }
        }
        console.log('[collectFormData] final hiddenFeatures:', JSON.stringify(hiddenFeatures.filter(h => h.type === 'snapring')));

        // ── 베어링(깊은 홈 볼베어링) 데이터 수집 ──
        const brCount = parseInt(bearingCountInput.value) || 0;
        for (let k = 0; k < brCount; k++) {
          const block = bearingInputsDiv.querySelector(`.br-block[data-br-idx="${k}"]`);
          if (!block) continue;
          const brSec = block.querySelector('.br-sec')?.value || '';
          const brDesig = (block.querySelector('.br-desig')?.value || '').trim();
          const brBore = parseFloat(block.getAttribute('data-br-d'));    // 내경 d
          const brOuter = parseFloat(block.getAttribute('data-br-D'));   // 외경 D
          const brWidth = parseFloat(block.getAttribute('data-br-B'));   // 폭 B
          const brFillet = parseFloat(block.getAttribute('data-br-r'));  // 필렛 r
          const brFit = block.getAttribute('data-br-fit') || 'ok';       // ok | forced | invalid
          const brLeftOff = parseFloat(block.querySelector('.br-left-off')?.value);
          let brRightOff = parseFloat(block.querySelector('.br-right-off')?.value);
          if (isNaN(brRightOff) && !isNaN(brLeftOff) && brWidth > 0) {
            const secIdx = parseInt(String(brSec).replace(/^S/i, ''), 10) - 1;
            const lenEl = sectionInputsDiv.querySelector(`.sec-length[data-idx="${secIdx}"]`);
            const shaftLen = lenEl ? parseFloat(lenEl.value) : NaN;
            if (!isNaN(shaftLen)) brRightOff = Math.round((shaftLen - (brWidth + brLeftOff)) * 100) / 100;
          }
          console.log(`[collectFormData] BR[${k}]: sec=${brSec}, desig=${brDesig}, d=${brBore}, D=${brOuter}, B=${brWidth}, r=${brFillet}, fit=${brFit}, leftOff=${brLeftOff}, rightOff=${brRightOff}`);

          // 유효 조건: 구간 선택 + 규격 조회 성공(D/B 존재) + fit이 invalid 아님
          if (brSec && brOuter > 0 && brWidth > 0 && brFit !== 'invalid') {
            hiddenFeatures.push({
              id: `HF_BR${k + 1}`,
              section: brSec,
              type: 'bearing',
              bearingDesignation: brDesig,
              bearingBore: brBore,        // d (내경)
              bearingOuter: brOuter,      // D (외경)
              bearingWidth: brWidth,      // B (폭)
              bearingFillet: brFillet,    // r (필렛)
              bearingLeftOffset: isNaN(brLeftOff) ? null : brLeftOff,
              bearingRightOffset: isNaN(brRightOff) ? null : brRightOff,
              bearingForcedFit: (brFit === 'forced'),  // 억지 끼워맞춤 여부
              confidence: CONF.CONFIRMED,
            });
          }
        }
        console.log('[collectFormData] bearings:', JSON.stringify(hiddenFeatures.filter(h => h.type === 'bearing')));

        // ── 관통 구멍 데이터 수집 ──
        const thCount = parseInt(throughHoleCountInput.value) || 0;
        for (let k = 0; k < thCount; k++) {
          const thSec = throughHoleInputsDiv.querySelector(`.th-sec[data-th-idx="${k}"]`)?.value || '';
          const thDiam = parseFloat(throughHoleInputsDiv.querySelector(`.th-diam[data-th-idx="${k}"]`)?.value);
          const thOffset = parseFloat(throughHoleInputsDiv.querySelector(`.th-offset[data-th-idx="${k}"]`)?.value);
          const thRightOff = parseFloat(throughHoleInputsDiv.querySelector(`.th-right-off[data-th-idx="${k}"]`)?.value);

          if (thSec && thDiam > 0) {
            hiddenFeatures.push({
              id: `HF_TH${k + 1}`,
              section: thSec,
              type: 'through-hole',
              diameter: thDiam,
              offsetFromLeft: isNaN(thOffset) ? null : thOffset,
              offsetFromRight: isNaN(thRightOff) ? null : thRightOff,
              confidence: CONF.CONFIRMED,
            });
          }
        }

        // ── 체인스프라켓(스프라켓) 데이터 수집 ──
        const cgCount = parseInt(chainGearCountInput.value) || 0;
        const chainGears = [];
        const firstSec = 'S1';
        const lastSecId = `S${count}`;
        for (let k = 0; k < cgCount; k++) {
          const cgSec = chainGearInputsDiv.querySelector(`.cg-sec[data-cg-idx="${k}"]`)?.value || '';
          const isBetween = cgSec.includes('~');
          let cgSide, cgPlacement, cgSectionLeft, cgSectionRight;
          if (isBetween) {
            cgPlacement = 'between';
            const parts = cgSec.split('~');
            cgSectionLeft = parts[0];
            cgSectionRight = parts[1];
            cgSide = 'left'; // default, overridden by bossDirection below
          } else {
            cgPlacement = 'edge';
            cgSide = (cgSec === firstSec) ? 'left' : 'right';
            cgSectionLeft = null;
            cgSectionRight = null;
          }

          // 보조투상도 체크박스
          const cgAuxView = chainGearInputsDiv.querySelector(`.cg-aux-view[data-cg-idx="${k}"]`)?.checked ?? true;
          const cgChainSpec = chainGearInputsDiv.querySelector(`.cg-chain-spec[data-cg-idx="${k}"]`)?.value || 'RS35';
          const cgTeeth = parseInt(chainGearInputsDiv.querySelector(`.cg-teeth[data-cg-idx="${k}"]`)?.value) || 9;
          const cgOuterDiam = parseFloat(chainGearInputsDiv.querySelector(`.cg-outer-diam[data-cg-idx="${k}"]`)?.value);
          const cgBoreDiam = parseFloat(chainGearInputsDiv.querySelector(`.cg-bore-diam[data-cg-idx="${k}"]`)?.value);
          const cgWidth = parseFloat(chainGearInputsDiv.querySelector(`.cg-width[data-cg-idx="${k}"]`)?.value);

          // 키홈
          const cgKeyCheck = chainGearInputsDiv.querySelector(`.cg-key-check[data-cg-idx="${k}"]`)?.checked;
          let cgKey = null;
          if (cgKeyCheck) {
            cgKey = {
              width: parseFloat(chainGearInputsDiv.querySelector(`.cg-key-w[data-cg-idx="${k}"]`)?.value) || 0,
              height: parseFloat(chainGearInputsDiv.querySelector(`.cg-key-h[data-cg-idx="${k}"]`)?.value) || 0,
              depth: parseFloat(chainGearInputsDiv.querySelector(`.cg-key-d[data-cg-idx="${k}"]`)?.value) || 0,
            };
          }

          // 보스 — 보스별(per-boss) 데이터 수집
          const cgBossCheck = chainGearInputsDiv.querySelector(`.cg-boss-check[data-cg-idx="${k}"]`)?.checked;
          let cgBoss = null;
          if (cgBossCheck) {
            const bossCount = parseInt(chainGearInputsDiv.querySelector(`.cg-boss-count[data-cg-idx="${k}"]`)?.value) || 1;
            const bossList = [];
            for (let b = 0; b < bossCount; b++) {
              const bOuter = parseFloat(chainGearInputsDiv.querySelector(`.cg-boss-outer[data-cg-idx="${k}"][data-boss-idx="${b}"]`)?.value) || 0;
              const bThick = parseFloat(chainGearInputsDiv.querySelector(`.cg-boss-thick[data-cg-idx="${k}"][data-boss-idx="${b}"]`)?.value) || 0;
              const bRCheck = chainGearInputsDiv.querySelector(`.cg-boss-r-check[data-cg-idx="${k}"][data-boss-idx="${b}"]`)?.checked;
              let bFillet = null;
              if (bRCheck) {
                bFillet = {
                  value: parseFloat(chainGearInputsDiv.querySelector(`.cg-boss-r-val[data-cg-idx="${k}"][data-boss-idx="${b}"]`)?.value) || 0,
                  side: chainGearInputsDiv.querySelector(`.cg-boss-r-side[data-cg-idx="${k}"][data-boss-idx="${b}"]`)?.value || 'both',
                };
              }
              bossList.push({ outerDiam: bOuter, thickness: bThick, fillet: bFillet });
            }
            cgBoss = {
              count: bossCount,
              bosses: bossList,   // per-boss data array
              // 하위호환: 단일 보스 접근용
              outerDiam: bossList[0]?.outerDiam || 0,
              thickness: bossList[0]?.thickness || 0,
              fillet: bossList[0]?.fillet || null,
            };
          }

          // 보스 위치(좌/우) — UI 셀렉트에서 읽기
          const cgBossDirVal = chainGearInputsDiv.querySelector(`.cg-boss-dir[data-cg-idx="${k}"]`)?.value || 'left';

          if (cgSec && cgOuterDiam > 0) {
            const cgData = {
              id: `CG${k + 1}`,
              section: isBetween ? cgSectionLeft : cgSec,
              side: cgSide,
              chainSpec: cgChainSpec,
              teeth: cgTeeth,
              outerDiam: cgOuterDiam,
              boreDiam: cgBoreDiam || 0,
              gearWidth: cgWidth || 0,
              key: cgKey,
              boss: cgBoss,
              auxView: cgAuxView,
              bossDirection: cgBossDirVal,
              confidence: CONF.CONFIRMED,
            };
            if (isBetween) {
              cgData.placement = 'between';
              cgData.sectionLeft = cgSectionLeft;
              cgData.sectionRight = cgSectionRight;
            }
            chainGears.push(cgData);
          }
        }

        // ── 중공축 보조투상도 (hollow shaft cross-section) ──
        // 중공축 선택 시, 마지막 구간 우측에 단면도(동심원: 외경+내경) 보조투상도 추가
        let hollowShaftData = null;
        if (shaftType === 'hollow') {
          const boreDiam = parseFloat(document.getElementById('paramHollowBoreDiam').value);
          if (boreDiam && boreDiam > 0) {
            // 마지막 구간의 직경 = 외경
            const lastDiamData = allDiameters[count - 1];
            const outerDiam = lastDiamData?.value || null;

            hollowShaftData = {
              type: 'hollow',
              boreDiameter: boreDiam,           // 내경 (중공 직경)
              outerDiameter: outerDiam,         // 외경 (마지막 구간 직경)
              relatedSection: `S${count}`,      // 마지막 구간
              position: 'right-end',            // 마지막 구간 우측 끝
            };

            // 중공축 보조투상도는 hollowShaftData로 전달됨
            // ai-engine.js Section 9.5에서 전용 렌더링 처리
            // (auxiliaryViews에 추가하지 않음 — Section 10 obround 렌더링과 중복 방지)
          } else {
            alert('중공축의 내경을 입력해주세요.');
            return null;
          }
        }

        // ── 최종 signals 객체 ──
        return {
          hasHorizontalCenterline: { value: true, confidence: CONF.CONFIRMED },
          shaftLikelihood: { value: 0.95, confidence: CONF.CONFIRMED },
          shaftType,        // 'solid' or 'hollow'
          hollowShaftData,  // null (중실축) or { boreDiameter, outerDiameter, ... } (중공축)
          totalLength: totalLength != null
            ? { value: totalLength, confidence: CONF.CONFIRMED }
            : null,
          segmentLengths,
          diameters,
          holes: [],
          slots: [],
          hiddenFeatures,
          auxiliaryViews,
          chamfers: [
            { side: 'left', spec: null, confidence: CONF.UNCERTAIN },
            { side: 'right', spec: null, confidence: CONF.UNCERTAIN },
          ],
          sectionChamfers,  // v111: 구간별 모따기 [{section, left, right}, ...]
          // ★ v114: 구간별 프로파일 (CYLINDER/TAPER)
          sectionProfiles: allDiameters.map(d => ({
            section: d.section,
            profile: d.profile || 'CYLINDER',
            diameterEnd: d.valueDiamEnd,  // TAPER인 경우 우측 직경
          })),
          keyways: [],
          centerHoles: [
            { side: 'left', diameter: null, confidence: CONF.UNCERTAIN },
            { side: 'right', diameter: null, confidence: CONF.UNCERTAIN },
          ],
          material: {
            value: material,
            confidence: material ? CONF.CONFIRMED : CONF.UNCERTAIN,
          },
          surfaceFinish: {
            value: null,
            confidence: CONF.UNCERTAIN,
          },
          partName: {
            value: partName,
            confidence: partName ? CONF.CONFIRMED : CONF.UNCERTAIN,
          },
          scale: scaleStr,
          projectionMethod: projectionMethod,
          paperSize: paperSize,
          uncertainSignals: [],
          tapSpecs,
          chainGears,
        };
      }
    });
  }

  /**
   * 메인 분석 함수 — 이미지 기본 분석 + 파라미터 다이얼로그
   * @param {File} file - 업로드된 이미지
   * @returns {Promise<Object>} signals 데이터
   */
  async function analyze(file) {
    // Step 1: 기본 이미지 분석 (에지 검출 등)
    const basicResult = await analyzeImageBasic(file);
    console.log('[ImageAnalyzer] Basic analysis result:', basicResult);

    // Step 2: 사용자 입력 다이얼로그
    const signals = await showParameterDialog(file, basicResult);
    return signals;
  }

  /**
   * doc._spec → prefillData 역변환
   * 저장된 도면의 spec을 파라미터 입력 폼에 다시 채울 수 있는 형식으로 변환
   */
  function specToEditData(spec) {
    if (!spec) return null;

    const geo = spec.geometrySpec || {};
    const ann = spec.annotationSpec || {};
    const sections = (geo.sections || []).map(s => ({
      id: s.id,
      length: s.length,
      diameter: s.diameter,
      chamferLeft: s.chamferLeft || 0,    // v111: 모따기
      chamferRight: s.chamferRight || 0,  // v111: 모따기
      profile: s.profile || 'CYLINDER',   // v114: 프로파일 타입
      diameterEnd: s.diameterEnd || null, // v114: 테이퍼 끝직경
    }));

    const pd = {
      _sectionCount: sections.length,
      sections,
      paperSize: ann.paperSize || 'A3',
      material: ann.material || '',
      totalLength: geo.totalLength || null,
      partName: ann.partName || '',
      scale: ann.scale || '1:1',
      projectionMethod: ann.projectionMethod || '3각법',
      shaftType: spec.shaftType || 'solid',
      hollowBoreDiam: spec.hollowShaftData?.boreDiameter || null,
    };

    // TAP (tap-bore hidden features)
    const hfs = geo.hiddenFeatures || [];
    const tapL = hfs.find(h => h.type === 'tap-bore' && h.side === 'left');
    const tapR = hfs.find(h => h.type === 'tap-bore' && h.side === 'right');
    if (tapL) {
      pd.leftTap = `M${tapL.diameter || ''}`;
      pd.leftTapDepth = tapL.depth || '';
      pd.leftTapType = tapL.threadType || 'coarse';     // v176: 나사 종류
      pd.leftTapPitch = tapL.pitch || null;               // v176: 피치
      if (tapL.counterBore) pd.leftCB = { diameter: tapL.counterBore.diameter, depth: tapL.counterBore.depth };
    }
    if (tapR) {
      pd.rightTap = `M${tapR.diameter || ''}`;
      pd.rightTapDepth = tapR.depth || '';
      pd.rightTapType = tapR.threadType || 'coarse';     // v176: 나사 종류
      pd.rightTapPitch = tapR.pitch || null;               // v176: 피치
      if (tapR.counterBore) pd.rightCB = { diameter: tapR.counterBore.diameter, depth: tapR.counterBore.depth };
    }

    // 키홈
    const kwFeatures = hfs.filter(h => h.type === 'keyway');
    if (kwFeatures.length > 0) {
      pd.keyways = kwFeatures.map(kw => ({
        section: kw.section,
        width: kw.keywayWidth,       // 키홈 길이 L (v178)
        height: kw.keywayHeight,     // 키 높이 h
        depth: kw.keywayDepth,       // 키홈 깊이 t1
        breadth: kw.keywayBreadth,   // v178: 키 폭 b
        leftOffset: kw.keywayLeftOffset,
        rightOffset: kw.keywayRightOffset,
        direction: kw.keywayDirection || 'side',  // v116: 키 방향
        shape: kw.keywayShape || 'obround',       // v117: 키 형상
      }));
    }

    // 스냅링
    const srFeatures = hfs.filter(h => h.type === 'snapring');
    if (srFeatures.length > 0) {
      pd.snapRings = srFeatures.map(sr => ({
        section: sr.section,
        diam: sr.snapRingDiam,
        thickness: sr.snapRingThickness,
        leftOffset: sr.snapRingLeftOffset,
        rightOffset: sr.snapRingRightOffset,
      }));
    }

    // 관통 구멍
    const thFeatures = hfs.filter(h => h.type === 'through-hole');
    if (thFeatures.length > 0) {
      pd.throughHoles = thFeatures.map(th => ({
        section: th.section,
        diameter: th.diameter,
        offset: th.offsetFromLeft,
        rightOffset: th.offsetFromRight,
      }));
    }

    // 베어링(깊은 홈 볼베어링) — v158: 저장/복원 누락 버그 수정
    const brFeatures = hfs.filter(h => h.type === 'bearing');
    if (brFeatures.length > 0) {
      pd.bearings = brFeatures.map(br => ({
        section: br.section,
        designation: br.bearingDesignation,
        bore: br.bearingBore,       // d
        outer: br.bearingOuter,     // D
        width: br.bearingWidth,     // B
        fillet: br.bearingFillet,   // r
        leftOffset: br.bearingLeftOffset,
        rightOffset: br.bearingRightOffset,
        forcedFit: !!br.bearingForcedFit,
      }));
    }

    // 체인스프라켓
    if (spec.chainGears && spec.chainGears.length > 0) {
      pd.chainGears = spec.chainGears.map(cg => {
        const obj = {
          section: cg.section,
          side: cg.side,
          chainSpec: cg.chainSpec,
          teeth: cg.teeth,
          outerDiam: cg.outerDiam,
          boreDiam: cg.boreDiam,
          gearWidth: cg.gearWidth,
          key: cg.key || null,
          boss: cg.boss || null,
          auxView: cg.auxView !== false,  // 기본값 true
          bossDirection: cg.bossDirection || 'left',
        };
        // between 배치 데이터 보존
        if (cg.placement === 'between') {
          obj.placement = 'between';
          obj.sectionLeft = cg.sectionLeft;
          obj.sectionRight = cg.sectionRight;
        }
        return obj;
      });
    }

    return pd;
  }

  /**
   * 파라미터 수정 다이얼로그 열기 (DB에서 불러온 도면용)
   * @param {Object} spec - doc._spec (저장된 도면의 spec 데이터)
   * @returns {Promise<Object>} 수정된 signals 데이터
   */
  function showEditParameterDialog(spec) {
    const prefillData = specToEditData(spec);
    if (!prefillData) {
      return Promise.reject(new Error('파라미터 데이터가 없습니다'));
    }
    return showParameterDialog(null, null, prefillData);
  }

  return {
    analyze,
    analyzeImageBasic,
    showParameterDialog,
    showEditParameterDialog,
    specToEditData,
  };
})();

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

          <!-- 부가 정보 -->
          <div style="margin-bottom:16px;">
            <h3 style="font-size:14px; color:#93c5fd; margin:0 0 8px;">
              부가 정보 (선택)
            </h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <div>
                <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">
                  좌측 TAP (예: M20)
                </label>
                <div style="display:flex; gap:4px;">
                  <input type="text" id="paramLeftTap" placeholder="M20"
                    style="flex:1; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <input type="number" id="paramLeftTapDepth" placeholder="깊이"
                    style="width:60px; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
                <!-- 좌측 카운터보어 -->
                <div style="margin-top:4px;">
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
              <div>
                <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">
                  우측 TAP (예: M10)
                </label>
                <div style="display:flex; gap:4px;">
                  <input type="text" id="paramRightTap" placeholder="M10"
                    style="flex:1; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <input type="number" id="paramRightTapDepth" placeholder="깊이"
                    style="width:60px; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
                <!-- 우측 카운터보어 -->
                <div style="margin-top:4px;">
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

          <!-- 버튼 -->
          <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
            <button id="paramBtnCancel" style="
              padding:10px 20px; background:#374151; border:none; border-radius:8px;
              color:#e2e8f0; cursor:pointer; font-size:14px;
            ">취소</button>
            <button id="paramBtnGenerate" style="
              padding:10px 24px; background:linear-gradient(135deg,#3b82f6,#6366f1);
              border:none; border-radius:8px; color:white; cursor:pointer; font-size:14px; font-weight:600;
            ">도면 생성</button>
          </div>
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

        // 직경 변경 시 중공축 외경 자동 업데이트 + 스냅링 자동 규격 재계산
        sectionInputsDiv.querySelectorAll('.sec-diameter').forEach(el => {
          el.addEventListener('input', updateHollowOuterDiam);
          ['input', 'change'].forEach(evt => el.addEventListener(evt, () => {
            if (typeof refreshAllSnapRingBlocks === 'function') refreshAllSnapRingBlocks();
          }));
        });
        // 길이 변경 시 스냅링 우측 오프셋 자동 재계산
        sectionInputsDiv.querySelectorAll('.sec-length').forEach(el => {
          ['input', 'change'].forEach(evt => el.addEventListener(evt, () => {
            if (typeof refreshAllSnapRingBlocks === 'function') refreshAllSnapRingBlocks();
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

      // ── 키홈 동적 입력 빌더 ──
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
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
              <label style="font-size:10px; color:#6b7280;">키 형상:</label>
              <select class="kw-shape" data-kw-idx="${k}" style="padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#22d3ee; font-size:11px; cursor:pointer;">
                <option value="obround">양쪽 둥근형</option>
                <option value="one-side-round">한쪽 둥근형</option>
                <option value="rect">양쪽 네모형</option>
              </select>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">폭 (mm)</label>
                <input type="number" class="kw-w" data-kw-idx="${k}" placeholder="폭" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">높이 (mm)</label>
                <input type="number" class="kw-h" data-kw-idx="${k}" placeholder="높이" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">깊이 (mm)</label>
                <input type="number" class="kw-d" data-kw-idx="${k}" placeholder="깊이" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">좌측 이격 (mm)</label>
                <input type="number" class="kw-left-off" data-kw-idx="${k}" placeholder="좌측에서 거리" style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">우측 이격 (mm)</label>
                <input type="number" class="kw-right-off" data-kw-idx="${k}" placeholder="우측에서 거리" style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
            </div>
            <div style="font-size:10px; color:#6b7280; margin-top:4px;">
              * 좌/우 이격 = 해당 구간 끝에서 키홈 시작까지의 거리
            </div>
          `;
          keywayInputsDiv.appendChild(block);
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
            secSel && secSel.addEventListener(evt, () => refreshSnapRingBlock(k));
            leftOffEl && leftOffEl.addEventListener(evt, () => _updateSnapRingRightOffset(k));
            manualThickEl && manualThickEl.addEventListener(evt, () => _updateSnapRingRightOffset(k));
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

      // ★ 스냅링 수 변경 — 모든 이벤트 유형 등록
      buildSnapRingInputs(0);
      let _lastSrCount = 0;
      function onSnapRingCountChange() {
        const n = Math.min(Math.max(parseInt(snapRingCountInput.value) || 0, 0), 10);
        if (n === _lastSrCount) return;
        _lastSrCount = n;
        snapRingCountInput.value = n;
        buildSnapRingInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        snapRingCountInput.addEventListener(evt, onSnapRingCountChange);
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
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">구멍 직경 (mm)</label>
                <input type="number" class="th-diam" data-th-idx="${k}" placeholder="예: 5" step="0.1"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">좌측 이격 (mm, 선택)</label>
                <input type="number" class="th-offset" data-th-idx="${k}" placeholder="구간 중심" step="0.1"
                  style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
            </div>
            <div style="font-size:10px; color:#6b7280; margin-top:4px;">
              * 수직 관통 — 숨은선(파선)으로 표시
            </div>
          `;
          throughHoleInputsDiv.appendChild(block);
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
          if (pd.leftTap) {
            const el = document.getElementById('paramLeftTap'); if (el) el.value = pd.leftTap;
          }
          if (pd.leftTapDepth) {
            const el = document.getElementById('paramLeftTapDepth'); if (el) el.value = pd.leftTapDepth;
          }
          if (pd.leftCB) {
            const chk = document.getElementById('paramLeftCB');
            if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
            const dEl = document.getElementById('paramLeftCBDiam'); if (dEl && pd.leftCB.diameter) dEl.value = pd.leftCB.diameter;
            const dpEl = document.getElementById('paramLeftCBDepth'); if (dpEl && pd.leftCB.depth) dpEl.value = pd.leftCB.depth;
          }
          // TAP 우측
          if (pd.rightTap) {
            const el = document.getElementById('paramRightTap'); if (el) el.value = pd.rightTap;
          }
          if (pd.rightTapDepth) {
            const el = document.getElementById('paramRightTapDepth'); if (el) el.value = pd.rightTapDepth;
          }
          if (pd.rightCB) {
            const chk = document.getElementById('paramRightCB');
            if (chk) { chk.checked = true; chk.dispatchEvent(new Event('change')); }
            const dEl = document.getElementById('paramRightCBDiam'); if (dEl && pd.rightCB.diameter) dEl.value = pd.rightCB.diameter;
            const dpEl = document.getElementById('paramRightCBDepth'); if (dpEl && pd.rightCB.depth) dpEl.value = pd.rightCB.depth;
          }

          // 키홈
          if (pd.keyways && pd.keyways.length > 0) {
            keywayCountInput.value = pd.keyways.length;
            buildKeywayInputs(pd.keyways.length);
            pd.keyways.forEach((kw, k) => {
              const sel = keywayInputsDiv.querySelector(`.kw-sec[data-kw-idx="${k}"]`); if (sel && kw.section) sel.value = kw.section;
              const wEl = keywayInputsDiv.querySelector(`.kw-w[data-kw-idx="${k}"]`); if (wEl && kw.width) wEl.value = kw.width;
              const hEl = keywayInputsDiv.querySelector(`.kw-h[data-kw-idx="${k}"]`); if (hEl && kw.height) hEl.value = kw.height;
              const dEl = keywayInputsDiv.querySelector(`.kw-d[data-kw-idx="${k}"]`); if (dEl && kw.depth) dEl.value = kw.depth;
              const loEl = keywayInputsDiv.querySelector(`.kw-left-off[data-kw-idx="${k}"]`); if (loEl && kw.leftOffset != null) loEl.value = kw.leftOffset;
              const roEl = keywayInputsDiv.querySelector(`.kw-right-off[data-kw-idx="${k}"]`); if (roEl && kw.rightOffset != null) roEl.value = kw.rightOffset;
              const dirEl = keywayInputsDiv.querySelector(`.kw-dir[data-kw-idx="${k}"]`); if (dirEl && kw.direction) dirEl.value = kw.direction;  // v116: 키 방향 복원
              const shpEl = keywayInputsDiv.querySelector(`.kw-shape[data-kw-idx="${k}"]`); if (shpEl && kw.shape) shpEl.value = kw.shape;  // v117: 키 형상 복원
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

      // 버튼 이벤트
      document.getElementById('paramBtnCancel').addEventListener('click', () => {
        overlay.remove();
        reject(new Error('사용자가 취소했습니다'));
      });

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
          };
          // 카운터보어
          if (leftCBChecked && leftCBDiam > 0 && leftCBDepth > 0) {
            hfObj.counterBore = { diameter: leftCBDiam, depth: leftCBDepth };
          }
          hiddenFeatures.push(hfObj);
          let specStr = `${leftTap} TAP${leftTapDepth ? ' 깊이' + leftTapDepth : ''}`;
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
          };
          // 카운터보어
          if (rightCBChecked && rightCBDiam > 0 && rightCBDepth > 0) {
            hfObj.counterBore = { diameter: rightCBDiam, depth: rightCBDepth };
          }
          hiddenFeatures.push(hfObj);
          let specStr = `${rightTap} TAP${rightTapDepth ? ' 깊이' + rightTapDepth : ''}`;
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
          let kwW = parseFloat(keywayInputsDiv.querySelector(`.kw-w[data-kw-idx="${k}"]`)?.value);
          const kwH = parseFloat(keywayInputsDiv.querySelector(`.kw-h[data-kw-idx="${k}"]`)?.value);
          const kwD = parseFloat(keywayInputsDiv.querySelector(`.kw-d[data-kw-idx="${k}"]`)?.value);
          const kwLeftOff = parseFloat(keywayInputsDiv.querySelector(`.kw-left-off[data-kw-idx="${k}"]`)?.value);
          const kwRightOff = parseFloat(keywayInputsDiv.querySelector(`.kw-right-off[data-kw-idx="${k}"]`)?.value);
          const kwDir = keywayInputsDiv.querySelector(`.kw-dir[data-kw-idx="${k}"]`)?.value || 'side';  // v116: 키 방향
          const kwShape = keywayInputsDiv.querySelector(`.kw-shape[data-kw-idx="${k}"]`)?.value || 'obround';  // v117: 키 형상

          // 양쪽 오프셋이 있고 폭이 없으면 자동 계산
          if (kwSec && !kwW && !isNaN(kwLeftOff) && !isNaN(kwRightOff)) {
            const secLen = segmentLengths.find(s => s.position === kwSec);
            if (secLen && secLen.value) {
              kwW = secLen.value - kwLeftOff - kwRightOff;
            }
          }

          if (kwSec && kwW && kwW > 0) {
            hiddenFeatures.push({
              id: `HF_KW${k + 1}`,
              section: kwSec,
              type: 'keyway',
              keywayWidth: kwW,
              keywayHeight: kwH || 6,
              keywayDepth: kwD || 3.5,
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
                shape: { type: kwShape || 'obround', width: kwW, height: kwH || 6, confidence: CONF.CONFIRMED },
                dimensions: [
                  { axis: 'horizontal', value: kwW, confidence: CONF.CONFIRMED },
                  { axis: 'vertical', value: kwH || 6, confidence: CONF.CONFIRMED },
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

        // ── 관통 구멍 데이터 수집 ──
        const thCount = parseInt(throughHoleCountInput.value) || 0;
        for (let k = 0; k < thCount; k++) {
          const thSec = throughHoleInputsDiv.querySelector(`.th-sec[data-th-idx="${k}"]`)?.value || '';
          const thDiam = parseFloat(throughHoleInputsDiv.querySelector(`.th-diam[data-th-idx="${k}"]`)?.value);
          const thOffset = parseFloat(throughHoleInputsDiv.querySelector(`.th-offset[data-th-idx="${k}"]`)?.value);

          if (thSec && thDiam > 0) {
            hiddenFeatures.push({
              id: `HF_TH${k + 1}`,
              section: thSec,
              type: 'through-hole',
              diameter: thDiam,
              offsetFromLeft: isNaN(thOffset) ? null : thOffset,
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
      if (tapL.counterBore) pd.leftCB = { diameter: tapL.counterBore.diameter, depth: tapL.counterBore.depth };
    }
    if (tapR) {
      pd.rightTap = `M${tapR.diameter || ''}`;
      pd.rightTapDepth = tapR.depth || '';
      if (tapR.counterBore) pd.rightCB = { diameter: tapR.counterBore.diameter, depth: tapR.counterBore.depth };
    }

    // 키홈
    const kwFeatures = hfs.filter(h => h.type === 'keyway');
    if (kwFeatures.length > 0) {
      pd.keyways = kwFeatures.map(kw => ({
        section: kw.section,
        width: kw.keywayWidth,
        height: kw.keywayHeight,
        depth: kw.keywayDepth,
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

/* ============================================================
   preview3d.js — 3D 미리보기 (Three.js 기반)
   
   shaft 구간 데이터(sections)를 회전체(lathe)로 변환하여 3D 렌더링.
   - 정면도에서 시작 (카메라: 축 정면 → -Z 방향)
   - 마우스 드래그: 회전
   - 마우스 스크롤: 확대/축소
   - v122: 나사구멍(tap-bore) 3D 표현 (끝면 중심 구멍)
   - v126: 체인스프라켓(chain sprocket) 3D 표현 (기어본체 + 보스 + 톱니)
   - v173: 깊은홈 볼베어링(deep groove ball bearing) 3D 표현
           외륜·내륜 LatheGeometry 회전체 + 볼 8개(45°간격) + CSG 클리핑
   ============================================================ */

const Preview3D = (() => {

  let _scene, _camera, _renderer, _mesh, _gridHelper;
  let _container = null;
  let _animFrameId = null;

  // ── 마우스 컨트롤 상태 ──
  let _isDragging = false;
  let _prevMouse = { x: 0, y: 0 };
  let _rotation = { x: 0, y: 0 };    // 현재 회전 (라디안)
  let _targetRotation = { x: 0, y: 0 };
  let _cameraDistance = 5;
  let _targetDistance = 5;

  // ── 상수 ──
  const ROTATE_SPEED = 0.005;
  const ZOOM_SPEED = 0.001;
  const LERP_FACTOR = 0.12;
  const MIN_DISTANCE = 1;
  const MAX_DISTANCE = 50;
  const SEGMENTS_RADIAL = 64;    // 원주 방향 분할 수

  /**
   * 3D 미리보기 열기
   * @param {Object} spec — doc._spec (geometrySpec.sections 포함)
   */
  function open(spec) {
    if (!spec || !spec.geometrySpec || !spec.geometrySpec.sections) {
      alert('3D 미리보기를 위한 구간 데이터가 없습니다.');
      return;
    }

    const sections = spec.geometrySpec.sections;
    if (sections.length === 0) {
      alert('구간 데이터가 비어있습니다.');
      return;
    }

    const hiddenFeatures = spec.geometrySpec.hiddenFeatures || [];
    const chainGears = spec.chainGears || [];

    _showModal();
    _initThreeJS();
    _buildShaftMesh(sections, hiddenFeatures, chainGears);
    _setCameraFrontView();
    _animate();
  }

  /** 모달 UI 표시 */
  function _showModal() {
    // 기존 모달 제거
    let existing = document.getElementById('preview3dModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'preview3dModal';
    modal.style.cssText = `
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(0,0,0,0.85);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    `;

    modal.innerHTML = `
      <div style="
        width: 90vw; height: 85vh;
        background: #1a1d2e; border-radius: 12px;
        display: flex; flex-direction: column;
        overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      ">
        <!-- Header -->
        <div style="
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 20px; background: #242836; border-bottom: 1px solid #3b3f51;
        ">
          <div style="display: flex; align-items: center; gap: 10px;">
            <i class="fas fa-cube" style="color: #60a5fa; font-size: 18px;"></i>
            <span style="color: #e2e8f0; font-size: 15px; font-weight: 600;">3D 미리보기</span>
            <span style="color: #6b7280; font-size: 12px; margin-left: 8px;">마우스 드래그: 회전 | 스크롤: 확대/축소</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button id="btn3dFront" class="prev3d-btn" title="정면도">정면</button>
            <button id="btn3dSide" class="prev3d-btn" title="측면도">측면</button>
            <button id="btn3dTop" class="prev3d-btn" title="평면도">평면</button>
            <button id="btn3dIso" class="prev3d-btn" title="등각투상">등각</button>
            <div style="width:1px; height:20px; background:#3b3f51; margin:0 4px;"></div>
            <button id="btn3dWire" class="prev3d-btn" title="와이어프레임 토글">와이어</button>
            <div style="width:1px; height:20px; background:#3b3f51; margin:0 4px;"></div>
            <button id="btn3dClose" style="
              background: #ef4444; color: white; border: none; border-radius: 6px;
              padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 600;
            ">✕ 닫기</button>
          </div>
        </div>

        <!-- 3D Canvas Container -->
        <div id="preview3dCanvas" style="flex: 1; position: relative; cursor: grab;"></div>
      </div>
    `;

    document.body.appendChild(modal);

    // CSS for buttons
    const style = document.createElement('style');
    style.id = 'preview3dStyles';
    style.textContent = `
      .prev3d-btn {
        background: #374151; color: #d1d5db; border: 1px solid #4b5563;
        border-radius: 6px; padding: 5px 12px; cursor: pointer;
        font-size: 12px; font-weight: 500; transition: all 0.15s;
      }
      .prev3d-btn:hover { background: #4b5563; color: #f3f4f6; }
      .prev3d-btn.active { background: #2563eb; color: #fff; border-color: #3b82f6; }
    `;
    if (!document.getElementById('preview3dStyles')) {
      document.head.appendChild(style);
    }

    _container = document.getElementById('preview3dCanvas');

    // Event bindings
    document.getElementById('btn3dClose').addEventListener('click', close);
    document.getElementById('btn3dFront').addEventListener('click', () => _setView('front'));
    document.getElementById('btn3dSide').addEventListener('click', () => _setView('side'));
    document.getElementById('btn3dTop').addEventListener('click', () => _setView('top'));
    document.getElementById('btn3dIso').addEventListener('click', () => _setView('iso'));
    document.getElementById('btn3dWire').addEventListener('click', _toggleWireframe);

    // ESC 닫기
    modal._onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', modal._onKey);

    // 모달 배경 클릭 닫기
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
  }

  /** Three.js 초기화 */
  function _initThreeJS() {
    const w = _container.clientWidth;
    const h = _container.clientHeight;

    // Scene
    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x1a1d2e);

    // Camera
    _camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);

    // Renderer
    _renderer = new THREE.WebGLRenderer({ antialias: true });
    _renderer.setSize(w, h);
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 톤매핑: 강한 하이라이트가 흰색으로 날아가는(blown-out) 현상 완화
    if (THREE.ACESFilmicToneMapping !== undefined) {
      _renderer.toneMapping = THREE.ACESFilmicToneMapping;
      _renderer.toneMappingExposure = 0.95;
    }
    _container.appendChild(_renderer.domElement);

    // Lights — 부드럽고 균일한 조명으로 흰색 번쩍임(하이라이트 몰림) 방지
    // 1) 환경광을 충분히 높여 전체를 고르게 밝힘
    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    _scene.add(ambient);

    // 2) 하늘/바닥 반구광 — 위는 밝게, 아래는 약간 어둡게(자연스러운 음영)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404654, 0.45);
    _scene.add(hemi);

    // 3) 메인 방향광 — 강도를 낮춰 강한 스펙큘러 하이라이트 억제
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.45);
    dirLight.position.set(5, 8, 7);
    _scene.add(dirLight);

    // 4) 반대편 보조광 — 그림자 면을 채워 균일하게
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.25);
    dirLight2.position.set(-5, -3, -6);
    _scene.add(dirLight2);

    // Grid (XZ plane)
    _gridHelper = new THREE.GridHelper(20, 40, 0x2a2d3e, 0x2a2d3e);
    _scene.add(_gridHelper);

    // Axis helper (작은 축)
    const axesHelper = new THREE.AxesHelper(1);
    _scene.add(axesHelper);

    // Mouse event bindings
    _container.addEventListener('mousedown', _onMouseDown);
    _container.addEventListener('mousemove', _onMouseMove);
    _container.addEventListener('mouseup', _onMouseUp);
    _container.addEventListener('mouseleave', _onMouseUp);
    _container.addEventListener('wheel', _onWheel, { passive: false });

    // Resize
    _container._onResize = () => {
      const nw = _container.clientWidth;
      const nh = _container.clientHeight;
      _camera.aspect = nw / nh;
      _camera.updateProjectionMatrix();
      _renderer.setSize(nw, nh);
    };
    window.addEventListener('resize', _container._onResize);

    // Reset control state
    _isDragging = false;
    _rotation = { x: 0, y: 0 };
    _targetRotation = { x: 0, y: 0 };
  }

  /**
   * 구간 데이터 → 3D 회전체 메시 생성
   * 
   * Three.js LatheGeometry: 2D 프로파일(Y축 기준 단면)을 회전
   * shaft 축 = X축, 직경 = Y축(=lathe의 반지름)
   * LatheGeometry는 Y축 중심으로 회전하므로,
   * 프로파일을 (radius, length) = (x, y) in lathe coords로 구성한 뒤
   * 최종 메시를 90° 회전하여 shaft 축 = Z축으로 배치
   */
  function _buildShaftMesh(sections, hiddenFeatures, chainGears) {
    // 기존 메시 제거 (Group일 수 있으므로 children 순회)
    if (_mesh) {
      _scene.remove(_mesh);
      _mesh.traverse((child) => {
        if (child.isMesh) {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        }
      });
      if (_mesh.geometry) _mesh.geometry.dispose();
      if (_mesh.material) _mesh.material.dispose();
      _mesh = null;
    }

    // 총 길이 계산
    const totalLength = sections.reduce((sum, s) => sum + (s.length || 0), 0);
    let maxDiam = Math.max(...sections.map(s => {
      const d1 = s.diameter || 20;
      const d2 = (s.profile === 'TAPER' && s.diameterEnd) ? s.diameterEnd : d1;
      return Math.max(d1, d2);
    }));
    // v126: 스프라켓 외경도 최대 직경에 포함
    (chainGears || []).forEach(cg => {
      if (cg.outerDiam > maxDiam) maxDiam = cg.outerDiam;
    });
    // v173: 베어링 외경(D)도 최대 직경에 포함 (카메라 거리·그리드 계산용)
    (hiddenFeatures || []).forEach(hf => {
      if (hf.type === 'bearing' && hf.bearingOuter > 0) {
        maxDiam = Math.max(maxDiam, hf.bearingOuter);
      }
    });

    // 스케일: 전체 길이를 ~6 유닛에 맞춤
    const scale = 6 / Math.max(totalLength, 1);

    const material = new THREE.MeshStandardMaterial({
      color: 0x9ca3af,
      metalness: 0.1,   // 금속 반사 줄임 (번쩍임 방지)
      roughness: 0.75,  // 표면을 무광에 가깝게 → 흰색 하이라이트 분산
      flatShading: false,
    });

    const group = new THREE.Group();
    // ★ v126: between 모드 스프라켓 gap 사전 계산
    const betweenGaps = {};
    (chainGears || []).forEach(cg => {
      if (cg.placement !== 'between') return;
      let gapMm = (cg.gearWidth || 8);
      if (cg.boss) {
        const bCount = cg.boss.count || 1;
        for (let b = 0; b < bCount; b++) {
          const bData = (cg.boss.bosses && cg.boss.bosses[b]) || cg.boss;
          gapMm += (bData && bData.thickness > 0) ? bData.thickness : 0;
        }
      }
      const leftId = cg.sectionLeft;
      betweenGaps[leftId] = Math.max(betweenGaps[leftId] || 0, gapMm);
    });
    const totalGapMm = Object.values(betweenGaps).reduce((s, v) => s + v, 0);

    const totalScaledLen = (totalLength + totalGapMm) * scale;
    let curY = -totalScaledLen / 2;

    // ★ v124: CSG Boolean Subtraction — 실제 구멍/홈 절삭
    // v176: DrawingModel.METRIC_COARSE_PITCH를 폴백으로 사용 (hiddenFeature.pitch 우선)
    const THREAD_PITCH = DrawingModel.METRIC_COARSE_PITCH || { 6: 1.0, 8: 1.25, 10: 1.5, 12: 1.75, 16: 2.0, 20: 2.5, 24: 3.0 };
    const tapFeatures = (hiddenFeatures || []).filter(hf => hf.type === 'tap-bore');
    const keywayFeatures = (hiddenFeatures || []).filter(hf => hf.type === 'keyway');
    const snapRingFeatures = (hiddenFeatures || []).filter(hf => hf.type === 'snapring');

    // CSG 사용 가능 여부 확인
    const useCSG = (typeof CSG !== 'undefined') && (tapFeatures.length > 0 || keywayFeatures.length > 0 || snapRingFeatures.length > 0);

    // 구간별 Y 오프셋 맵
    const sectionYMap = {};

    // ── STEP 1: 각 구간을 CylinderGeometry로 생성 ──
    const sectionMeshes = [];  // { mesh, secId, yCenter, r1, r2, len }

    sections.forEach((sec) => {
      const len = (sec.length || 0) * scale;
      if (len <= 0) return;

      const d1 = (sec.diameter || 20);
      const d2 = (sec.profile === 'TAPER' && sec.diameterEnd) ? sec.diameterEnd : d1;
      const r1 = (d1 / 2) * scale;
      const r2 = (d2 / 2) * scale;

      const yCenter = curY + len / 2;

      sectionYMap[sec.id] = {
        yStart: curY,
        yEnd: curY + len,
        rLeft: r1,
        rRight: r2,
      };

      // 솔리드 실린더 (양쪽 cap 포함)
      // CylinderGeometry(radiusTop, radiusBottom): Top=+Y(구간 끝/오른쪽), Bottom=-Y(구간 시작/왼쪽)
      // r1=diameter(좌측 시작), r2=diameterEnd(우측 끝) → Top=r2, Bottom=r1
      const cylGeo = new THREE.CylinderGeometry(r2, r1, len, SEGMENTS_RADIAL, 1, false);
      const cylMesh = new THREE.Mesh(cylGeo, material.clone());
      cylMesh.position.set(0, yCenter, 0);
      cylMesh.updateMatrix();

      sectionMeshes.push({
        mesh: cylMesh,
        secId: sec.id,
        yCenter: yCenter,
        r1: r1,
        r2: r2,
        len: len,
      });

      curY += len;

      // v126: between gap 삽입
      if (betweenGaps[sec.id]) {
        curY += betweenGaps[sec.id] * scale;
      }
    });

    // ── STEP 2: CSG Boolean Subtraction 수행 ──
    if (useCSG) {
      sectionMeshes.forEach((secObj) => {
        let currentCSG = CSG.fromMesh(secObj.mesh);
        const secInfo = sectionYMap[secObj.secId];
        if (!secInfo) {
          // CSG 불가 — 그대로 추가
          group.add(secObj.mesh);
          return;
        }

        let hasSubtraction = false;

        // ── 나사구멍(tap-bore) CSG subtract ──
        tapFeatures.forEach(hf => {
          if (hf.section !== secObj.secId) return;

          const tapDiam = hf.diameter || 10;
          const tapDepth = hf.depth || 20;
          // v176: hiddenFeature에 저장된 피치 우선 사용, 없으면 보통나사 테이블 폴백
          const pitch = hf.pitch || THREAD_PITCH[tapDiam] || 1.5;
          const drillDiam = tapDiam - pitch;
          const drillDepth = tapDepth + 2;

          const tapR = (tapDiam / 2) * scale;
          const drillR = (drillDiam / 2) * scale;
          const tapLen = tapDepth * scale;
          const drillLen = drillDepth * scale;

          let holeY;
          const dir = (hf.side === 'left') ? 1 : -1;

          if (hf.side === 'left') {
            holeY = secInfo.yStart;
          } else {
            holeY = secInfo.yEnd;
          }

          // 탭 구멍 절삭 실린더 (tap 구간)
          // 실린더를 구멍 위치에 배치: 중심 = 구멍 시작면에서 depth/2 안쪽
          const tapToolGeo = new THREE.CylinderGeometry(tapR, tapR, tapLen + 0.01, SEGMENTS_RADIAL, 1, false);
          const tapToolMesh = new THREE.Mesh(tapToolGeo, material);
          tapToolMesh.position.set(0, holeY + dir * tapLen / 2, 0);
          tapToolMesh.updateMatrix();

          try {
            const toolCSG = CSG.fromMesh(tapToolMesh);
            currentCSG = currentCSG.subtract(toolCSG);
            hasSubtraction = true;
          } catch (e) {
            console.warn('CSG tap-bore subtract failed:', e);
          }

          tapToolGeo.dispose();

          // 드릴 구간 (더 작은 직경, 더 깊이)
          if (drillDepth > tapDepth) {
            const drillExtraLen = (drillDepth - tapDepth) * scale;
            const drillToolGeo = new THREE.CylinderGeometry(drillR, drillR, drillExtraLen + 0.01, SEGMENTS_RADIAL, 1, false);
            const drillToolMesh = new THREE.Mesh(drillToolGeo, material);
            drillToolMesh.position.set(0, holeY + dir * (tapLen + drillExtraLen / 2), 0);
            drillToolMesh.updateMatrix();

            try {
              const drillCSG = CSG.fromMesh(drillToolMesh);
              currentCSG = currentCSG.subtract(drillCSG);
            } catch (e) {
              console.warn('CSG drill subtract failed:', e);
            }

            drillToolGeo.dispose();
          }
        });

        // ── 키홈(keyway) CSG subtract ──
        // v125: keywayShape에 따라 양쪽둥근(obround)/한쪽둥근(one-side-round)/양쪽네모(rect) 형상
        keywayFeatures.forEach(hf => {
          if (hf.section !== secObj.secId) return;

          const secData = sections.find(s => s.id === hf.section);
          if (!secData) return;

          const kwDirection = hf.keywayDirection || 'side';
          const kwShape = hf.keywayShape || 'obround';
          const kwWidthMm = hf.keywayWidth || 10;     // 축 방향 길이 (mm)
          const kwHeightMm = hf.keywayHeight || 6;    // 키홈 폭 — 원주 방향 (mm)
          const kwDepthMm = hf.keywayDepth || 3.5;    // 반지름 방향 깊이 (mm)
          const sectionLenMm = secData.length || 1;
          const secDiamMm = secData.diameter || 20;
          const secR = (secDiamMm / 2) * scale;

          // 키홈 치수 (3D 유닛)
          const kwLen = kwWidthMm * scale;             // 축 방향 (Y)
          const kwW = kwHeightMm * scale;              // 원주 방향 (폭)
          const kwD = kwDepthMm * scale;               // 반지름 방향 (깊이)

          // 키홈 Y 중심 위치 (축 방향)
          const hasLeftOff = hf.keywayLeftOffset != null && !isNaN(hf.keywayLeftOffset);
          const hasRightOff = hf.keywayRightOffset != null && !isNaN(hf.keywayRightOffset);

          let kwYCenter;
          if (hasLeftOff && hasRightOff) {
            const actualWidth = sectionLenMm - hf.keywayLeftOffset - hf.keywayRightOffset;
            const centerFromLeft = hf.keywayLeftOffset + actualWidth / 2;
            kwYCenter = secInfo.yStart + centerFromLeft * scale;
          } else if (hasLeftOff) {
            kwYCenter = secInfo.yStart + (hf.keywayLeftOffset + kwWidthMm / 2) * scale;
          } else if (hasRightOff) {
            kwYCenter = secInfo.yEnd - (hf.keywayRightOffset + kwWidthMm / 2) * scale;
          } else {
            kwYCenter = (secInfo.yStart + secInfo.yEnd) / 2;
          }

          // 한쪽 둥근형 방향 결정
          let roundSide = 'right';
          if (kwShape === 'one-side-round') {
            const loVal = parseFloat(hf.keywayLeftOffset);
            const roVal = parseFloat(hf.keywayRightOffset);
            if (!isNaN(roVal) && roVal === 0) roundSide = 'left';
            else if (!isNaN(loVal) && loVal === 0) roundSide = 'right';
          }

          // 절삭 도구 높이: 표면 위까지 충분히 확장
          const cutBoxH = kwD + secR;
          const roundR = kwW / 2;  // 둥근 끝단 반지름 = 폭의 절반

          // ── 키홈 형상에 따라 절삭 도구 CSG 구성 ──
          // 좌표축 규칙 (pre-rotation):
          //   Y = shaft 축 방향, Z or X = 깊이 방향 (kwDirection에 따라)
          //   kwW 방향 = 폭 (side: X, front: Z)
          //   kwLen 방향 = 축 길이 (Y)
          //   cutBoxH 방향 = 깊이 (side: Z, front: X)

          let toolCSG = null;

          try {
            if (kwShape === 'rect') {
              // ── 양쪽 네모형: 순수 박스 ──
              let toolMesh;
              if (kwDirection === 'side') {
                const geo = new THREE.BoxGeometry(kwW, kwLen + 0.01, cutBoxH);
                toolMesh = new THREE.Mesh(geo, material);
                toolMesh.position.set(0, kwYCenter, secR - kwD + cutBoxH / 2);
              } else {
                const geo = new THREE.BoxGeometry(cutBoxH, kwLen + 0.01, kwW);
                toolMesh = new THREE.Mesh(geo, material);
                toolMesh.position.set(secR - kwD + cutBoxH / 2, kwYCenter, 0);
              }
              toolMesh.updateMatrix();
              toolCSG = CSG.fromMesh(toolMesh);
              toolMesh.geometry.dispose();

            } else if (kwShape === 'obround') {
              // ── 양쪽 둥근형: 박스 몸체 + 양쪽 반원통 ──
              // 박스 길이 = kwLen - 2 * roundR (양쪽 반원 제외한 직선부)
              const bodyLen = Math.max(kwLen - 2 * roundR, 0.001);

              let bodyMesh;
              if (kwDirection === 'side') {
                const bodyGeo = new THREE.BoxGeometry(kwW, bodyLen + 0.01, cutBoxH);
                bodyMesh = new THREE.Mesh(bodyGeo, material);
                bodyMesh.position.set(0, kwYCenter, secR - kwD + cutBoxH / 2);
              } else {
                const bodyGeo = new THREE.BoxGeometry(cutBoxH, bodyLen + 0.01, kwW);
                bodyMesh = new THREE.Mesh(bodyGeo, material);
                bodyMesh.position.set(secR - kwD + cutBoxH / 2, kwYCenter, 0);
              }
              bodyMesh.updateMatrix();
              toolCSG = CSG.fromMesh(bodyMesh);
              bodyMesh.geometry.dispose();

              // 양쪽 반원통 (Y축 양쪽 끝, 반원 = 반지름 roundR의 원통)
              // CylinderGeometry는 Y축 중심이므로 깊이 방향(Z 또는 X)으로 회전 필요
              const capSegments = 32;
              for (const yDir of [-1, 1]) {
                // yDir = -1: left end (yStart 쪽), +1: right end (yEnd 쪽)
                const capY = kwYCenter + yDir * (kwLen / 2 - roundR);

                let capMesh;
                if (kwDirection === 'side') {
                  // 반원통: Z방향으로 뻗어야 함 → X축 회전
                  const capGeo = new THREE.CylinderGeometry(roundR, roundR, cutBoxH, capSegments, 1, false);
                  capMesh = new THREE.Mesh(capGeo, material);
                  capMesh.position.set(0, capY, secR - kwD + cutBoxH / 2);
                  capMesh.rotation.x = Math.PI / 2;
                } else {
                  // 반원통: X방향으로 뻗어야 함 → Z축 회전
                  const capGeo = new THREE.CylinderGeometry(roundR, roundR, cutBoxH, capSegments, 1, false);
                  capMesh = new THREE.Mesh(capGeo, material);
                  capMesh.position.set(secR - kwD + cutBoxH / 2, capY, 0);
                  capMesh.rotation.z = Math.PI / 2;
                }
                capMesh.updateMatrix();
                const capCSG = CSG.fromMesh(capMesh);
                toolCSG = toolCSG.union(capCSG);
                capMesh.geometry.dispose();
              }

            } else if (kwShape === 'one-side-round') {
              // ── 한쪽 둥근형: 박스 몸체 + 한쪽 반원통 ──
              // roundSide='left'  → yStart쪽(−Y)이 둥근, +Y쪽은 직각
              // roundSide='right' → yEnd쪽(+Y)이 둥근, -Y쪽은 직각
              // 2D에서 left=왼쪽=yStart(축 좌측), right=오른쪽=yEnd(축 우측)
              const bodyLen = Math.max(kwLen - roundR, 0.001);

              // 박스 중심을 직각쪽으로 offset
              const boxShift = (roundSide === 'right') ? -roundR / 2 : roundR / 2;

              let bodyMesh;
              if (kwDirection === 'side') {
                const bodyGeo = new THREE.BoxGeometry(kwW, bodyLen + 0.01, cutBoxH);
                bodyMesh = new THREE.Mesh(bodyGeo, material);
                bodyMesh.position.set(0, kwYCenter + boxShift, secR - kwD + cutBoxH / 2);
              } else {
                const bodyGeo = new THREE.BoxGeometry(cutBoxH, bodyLen + 0.01, kwW);
                bodyMesh = new THREE.Mesh(bodyGeo, material);
                bodyMesh.position.set(secR - kwD + cutBoxH / 2, kwYCenter + boxShift, 0);
              }
              bodyMesh.updateMatrix();
              toolCSG = CSG.fromMesh(bodyMesh);
              bodyMesh.geometry.dispose();

              // 둥근 쪽 반원통 추가
              const capY = (roundSide === 'right')
                ? kwYCenter + (kwLen / 2 - roundR)
                : kwYCenter - (kwLen / 2 - roundR);

              let capMesh;
              if (kwDirection === 'side') {
                const capGeo = new THREE.CylinderGeometry(roundR, roundR, cutBoxH, 32, 1, false);
                capMesh = new THREE.Mesh(capGeo, material);
                capMesh.position.set(0, capY, secR - kwD + cutBoxH / 2);
                capMesh.rotation.x = Math.PI / 2;
              } else {
                const capGeo = new THREE.CylinderGeometry(roundR, roundR, cutBoxH, 32, 1, false);
                capMesh = new THREE.Mesh(capGeo, material);
                capMesh.position.set(secR - kwD + cutBoxH / 2, capY, 0);
                capMesh.rotation.z = Math.PI / 2;
              }
              capMesh.updateMatrix();
              const capCSG = CSG.fromMesh(capMesh);
              toolCSG = toolCSG.union(capCSG);
              capMesh.geometry.dispose();

            } else {
              // fallback: rect처럼 처리
              let toolMesh;
              if (kwDirection === 'side') {
                const geo = new THREE.BoxGeometry(kwW, kwLen + 0.01, cutBoxH);
                toolMesh = new THREE.Mesh(geo, material);
                toolMesh.position.set(0, kwYCenter, secR - kwD + cutBoxH / 2);
              } else {
                const geo = new THREE.BoxGeometry(cutBoxH, kwLen + 0.01, kwW);
                toolMesh = new THREE.Mesh(geo, material);
                toolMesh.position.set(secR - kwD + cutBoxH / 2, kwYCenter, 0);
              }
              toolMesh.updateMatrix();
              toolCSG = CSG.fromMesh(toolMesh);
              toolMesh.geometry.dispose();
            }

            // 절삭 실행
            if (toolCSG) {
              currentCSG = currentCSG.subtract(toolCSG);
              hasSubtraction = true;
            }
          } catch (e) {
            console.warn('CSG keyway subtract failed:', e);
          }
        });

        // ── 스냅링 홈(snap ring groove) CSG subtract ──
        // 축 둘레를 감싸는 얇은 링(ring) 형태의 홈을 파낸다.
        //   홈 깊이 = (구간 외경 − 스냅링 외경) / 2  → 바닥 반지름 = srDiam/2
        //   홈 폭(축 방향) = 스냅링 두께(m)
        //   절삭 도구 = 바깥 원통(축 표면보다 살짝 큼) − 안쪽 원통(홈 바닥) = 링
        snapRingFeatures.forEach(hf => {
          if (hf.section !== secObj.secId) return;

          const secData = sections.find(s => s.id === hf.section);
          if (!secData) return;

          const secDiamMm = secData.diameter || 20;
          const srDiamMm = hf.snapRingDiam;      // 홈 바닥 지름 (d2)
          const srThickMm = hf.snapRingThickness; // 홈 폭 (m)
          const sectionLenMm = secData.length || 1;
          if (!(srDiamMm > 0) || !(srThickMm > 0)) return;

          const grooveDepthMm = (secDiamMm - srDiamMm) / 2;
          if (grooveDepthMm <= 0) return; // 홈이 축보다 크면 스킵

          const secR = (secDiamMm / 2) * scale;
          const bottomR = (srDiamMm / 2) * scale;     // 홈 바닥 반지름
          const grooveW = srThickMm * scale;          // 축 방향 폭
          const outerR = secR + 0.05;                 // 축 표면보다 살짝 크게 (클린 컷)

          // 홈 Y 중심 위치 (좌측 오프셋 우선 → 우측 오프셋 → 중앙)
          const hasLeftOff = hf.snapRingLeftOffset != null && !isNaN(hf.snapRingLeftOffset);
          const hasRightOff = hf.snapRingRightOffset != null && !isNaN(hf.snapRingRightOffset);
          let grooveYCenter;
          if (hasLeftOff) {
            grooveYCenter = secInfo.yStart + (hf.snapRingLeftOffset + srThickMm / 2) * scale;
          } else if (hasRightOff) {
            grooveYCenter = secInfo.yEnd - (hf.snapRingRightOffset + srThickMm / 2) * scale;
          } else {
            grooveYCenter = (secInfo.yStart + secInfo.yEnd) / 2;
          }

          try {
            // 바깥 원통 (축 방향 = Y, CylinderGeometry는 기본 Y축 정렬)
            const outerGeo = new THREE.CylinderGeometry(outerR, outerR, grooveW + 0.001, SEGMENTS_RADIAL, 1, false);
            const outerMesh = new THREE.Mesh(outerGeo, material);
            outerMesh.position.set(0, grooveYCenter, 0);
            outerMesh.updateMatrix();
            let ringCSG = CSG.fromMesh(outerMesh);
            outerGeo.dispose();

            // 안쪽 원통 (홈 바닥) — 관통되도록 폭을 넉넉히
            const innerGeo = new THREE.CylinderGeometry(bottomR, bottomR, grooveW + 0.02, SEGMENTS_RADIAL, 1, false);
            const innerMesh = new THREE.Mesh(innerGeo, material);
            innerMesh.position.set(0, grooveYCenter, 0);
            innerMesh.updateMatrix();
            const innerCSG = CSG.fromMesh(innerMesh);
            innerGeo.dispose();

            // 링 = 바깥 − 안쪽
            const toolCSG = ringCSG.subtract(innerCSG);
            currentCSG = currentCSG.subtract(toolCSG);
            hasSubtraction = true;
          } catch (e) {
            console.warn('CSG snapring groove subtract failed:', e);
          }
        });

        // ── 결과 메시 생성 ──
        if (hasSubtraction) {
          // CSG 결과를 메시로 변환
          const identity = new THREE.Matrix4();
          const resultMesh = CSG.toMesh(currentCSG, identity, material.clone());
          resultMesh.updateMatrix();
          group.add(resultMesh);

          // 원본 해제
          secObj.mesh.geometry.dispose();
          secObj.mesh.material.dispose();
        } else {
          // 절삭 없는 구간은 그대로 추가
          group.add(secObj.mesh);
        }
      });
    } else {
      // CSG 미지원 시 기본 실린더 추가 (fallback)
      sectionMeshes.forEach((secObj) => {
        group.add(secObj.mesh);
      });
    }

    // ★ v132: 체인스프라켓 3D — 단일 프로파일 LatheGeometry 방식 완전 재작성
    //
    // 핵심: 전체 조립체(기어본체+보스들)를 하나의 단면 프로파일로 구성하여
    //        LatheGeometry로 한 번에 회전 → 단차, R값(오목 필렛), 보어 자연 표현
    //
    // 사용자 요구사항:
    //   1. 기어 내경(bore) 반드시 표시
    //   2. 기어 이빨은 기어 본체(rootR) 위에만 — 보스에 절대 표시 금지
    //   3. R값은 오목(concave) 필렛 — 볼록(convex) 아님
    //   4. fillet.side='left'→왼쪽만, 'right'→오른쪽만, 'both'→양쪽 모두 오목 R적용
    //
    const RS_PITCH_MAP = { RS25: 6.35, RS35: 9.525, RS40: 12.7, RS50: 15.875, RS60: 19.05, RS80: 25.4, RS100: 31.75, RS120: 38.1 };

    const spMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.1, roughness: 0.75 });
    const boreMat = new THREE.MeshStandardMaterial({ color: 0x111118, metalness: 0.0, roughness: 1.0, side: THREE.BackSide });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.1, roughness: 0.75, side: THREE.DoubleSide });

    // 오목 필렛 포인트 생성 헬퍼
    // corner = 90° 안쪽 코너 (두 직선의 교점)
    // 원의 중심은 코너에서 빈 공간(노치) 방향으로 오프셋
    // from → arc → to 순서로 오목하게 깎아냄
    function concaveFilletPts(fromR, fromY, toR, toY, rVal, nSeg) {
      // from과 to가 90° 코너를 형성. rVal 반경의 오목 원호를 삽입.
      // 수평(R방향)→수직(Y방향) 또는 수직→수평 코너.
      const pts = [];
      const dR = toR - fromR; // R방향 변화
      const dY = toY - fromY; // Y방향 변화
      // 코너 = (toR, fromY) 또는 (fromR, toY)

      if (Math.abs(dR) > 0.0001 && Math.abs(dY) > 0.0001) {
        // L자 코너: 수평선(fromR,fromY)→(toR,fromY)→수직선(toR,fromY)→(toR,toY)
        // 오목 필렛: 코너(toR, fromY)의 안쪽을 둥글게
        // 원 중심: 코너에서 안쪽(빈공간)으로 rVal만큼
        const sgnR = dR > 0 ? 1 : -1; // R 증가 방향
        const sgnY = dY > 0 ? 1 : -1; // Y 증가 방향

        // 접점1(수평선 위): (toR - sgnR*rVal, fromY)
        // 접점2(수직선 위): (toR, fromY + sgnY*rVal)
        // 원 중심: (toR - sgnR*rVal, fromY + sgnY*rVal)
        const cx = toR - sgnR * rVal;
        const cy = fromY + sgnY * rVal;

        for (let i = 0; i <= nSeg; i++) {
          const t = i / nSeg;
          // 접점1(수평)에서 접점2(수직)까지 원호
          // 시작각: sgnR>0 && sgnY>0 → -PI/2, 등등
          let angStart, angEnd;
          if (sgnR > 0 && sgnY > 0) { angStart = -Math.PI/2; angEnd = 0; }
          else if (sgnR > 0 && sgnY < 0) { angStart = 0; angEnd = Math.PI/2; }
          else if (sgnR < 0 && sgnY > 0) { angStart = Math.PI; angEnd = Math.PI*3/2; }
          else { angStart = Math.PI/2; angEnd = Math.PI; }
          const ang = angStart + (angEnd - angStart) * t;
          pts.push(new THREE.Vector2(cx + rVal * Math.cos(ang), cy + rVal * Math.sin(ang)));
        }
      }
      return pts;
    }

    (chainGears || []).forEach((cg) => {
      const isBetween = cg.placement === 'between';
      let sec, secRight, side;
      if (isBetween) {
        sec = sections.find(s => s.id === cg.sectionLeft);
        secRight = sections.find(s => s.id === cg.sectionRight);
        if (!sec || !secRight) return;
        side = cg.bossDirection || 'left';
      } else {
        sec = sections.find(s => s.id === cg.section);
        if (!sec) return;
        side = cg.side || 'left';
      }
      const secInfo = sectionYMap[sec.id];
      const secRightInfo = secRight ? sectionYMap[secRight.id] : null;
      if (!secInfo) return;

      // ── 치수 ──
      const gearOuterR = (cg.outerDiam / 2) * scale;
      const boreR = Math.max((cg.boreDiam || 0) / 2 * scale, 0.001);
      const gearW = (cg.gearWidth || 8) * scale;
      const pitch = RS_PITCH_MAP[cg.chainSpec] || 9.525;
      const toothH = pitch * 0.3 * scale;
      const rootR = gearOuterR - toothH;

      // ── 보스 ──
      const bossList = [];
      if (cg.boss) {
        const cnt = cg.boss.count || 1;
        const src = (cg.boss.bosses && cg.boss.bosses.length > 0) ? cg.boss.bosses : null;
        for (let b = 0; b < cnt; b++) {
          bossList.push(src ? (src[b] || src[0]) : {
            outerDiam: cg.boss.outerDiam || 0, thickness: cg.boss.thickness || 0,
            fillet: cg.boss.fillet || null,
          });
        }
      }
      const totalBossThick = bossList.reduce((s, b) =>
        s + ((b && b.thickness > 0) ? b.thickness * scale : 0), 0);

      // ── 부품 리스트 (2D 좌→우 = 3D -Y→+Y) ──
      // side='left': [기어][boss0][boss1]...[구간]
      // side='right': [구간]...[boss1][boss0][기어]
      //
      // 각 부품: { r: 외경반경, w: 두께, fillet: {...}, type: 'gear'|'boss' }
      // 순서: 2D 도면의 좌→우 순서
      const partsLR = []; // 좌→우 순서
      partsLR.push({ r: rootR, w: gearW, fillet: null, type: 'gear' });
      bossList.forEach(bd => {
        if (!bd || bd.outerDiam <= 0 || bd.thickness <= 0) return;
        partsLR.push({
          r: (bd.outerDiam / 2) * scale,
          w: bd.thickness * scale,
          fillet: bd.fillet,
          type: 'boss',
        });
      });

      // ── 조립체 Y 범위 계산 ──
      const assemblyW = partsLR.reduce((s, p) => s + p.w, 0);
      let assemblyYStart; // 조립체의 가장 -Y(왼쪽) 끝
      if (isBetween) {
        const gapCenter = (secInfo.yEnd + secRightInfo.yStart) / 2;
        assemblyYStart = gapCenter - assemblyW / 2;
      } else if (side === 'left') {
        assemblyYStart = secInfo.yStart - assemblyW;
      } else {
        assemblyYStart = secInfo.yEnd;
      }

      // side='right'일 때 부품 순서를 뒤집어야 함
      // side='left': 2D 좌→우 = [기어][boss0][boss1] = -Y→+Y
      // side='right': 2D 좌→우 = [boss1][boss0][기어] → 3D에서는 뒤집어서 -Y→+Y
      const parts = (side === 'left') ? partsLR : [...partsLR].reverse();

      // 각 부품의 Y 시작/끝 계산
      let yCur = assemblyYStart;
      parts.forEach(p => {
        p.yStart = yCur;
        p.yEnd = yCur + p.w;
        yCur += p.w;
      });
      const assemblyYEnd = yCur;

      // ── 기어 부품 찾기 ──
      const gearPart = parts.find(p => p.type === 'gear');
      const gearYStart = gearPart.yStart;
      const gearYEnd = gearPart.yEnd;

      // ── A. 전체 조립체: 단일 프로파일 LatheGeometry ──
      // 프로파일: 외경 윤곽선을 좌→우(−Y→+Y)로 따라가면서
      //           각 부품 경계에서 단차 + R값(오목) 적용
      //
      // LatheGeometry 좌표: x=radius, y=축방향(Y)
      // 프로파일 구성 순서 (시계방향 단면):
      //   1. 내경 하단 (boreR, yMin) → 내경 상단 (boreR, yMax) [내벽: 생략, LatheGeometry가 처리]
      //   실제로는: 외경 프로파일만 (하단→상단, 각 단차에서 R값 적용)
      //   LatheGeometry는 열린 프로파일도 가능하지만, 닫힌 프로파일이 더 나음
      //
      // 닫힌 프로파일 (보어 포함):
      //   boreR,yMin → 외경프로파일 yMin→yMax → boreR,yMax → 내벽(boreR) 닫힘

      const profile = [];
      const FILLET_SEGS = 12;

      // 프로파일 시작: 내경 하단
      profile.push(new THREE.Vector2(boreR, assemblyYStart));

      // 외경 프로파일: 각 부품을 순서대로
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const prevP = i > 0 ? parts[i - 1] : null;

        // 이 부품의 R값 정보
        const fil = p.fillet;
        const hasR = fil && fil.value > 0;
        const rVal = hasR ? fil.value * scale : 0;
        const filSide = hasR ? (fil.side || 'both') : 'none';

        // 2D 기준 applyRL/applyRR (left/right = 도면의 좌/우)
        const applyRL_2d = hasR && (filSide === 'left' || filSide === 'both');
        const applyRR_2d = hasR && (filSide === 'right' || filSide === 'both');

        // 3D에서 이 부품의 왼쪽(-Y) / 오른쪽(+Y) 매핑
        // side='left': 3D -Y = 2D left, 3D +Y = 2D right
        // side='right': 부품 순서가 뒤집어졌으므로, 각 부품 내부의 좌/우도 뒤집힘
        //   원래 2D에서 boss0의 left = 기어쪽인데, reverse 후 3D에서는 boss0의 +Y = 기어쪽
        //   즉 side='right'이면 applyLeft(-Y) = applyRR_2d, applyRight(+Y) = applyRL_2d
        let applyLeft, applyRight; // 3D의 -Y쪽, +Y쪽
        if (side === 'left') {
          applyLeft = applyRL_2d;
          applyRight = applyRR_2d;
        } else {
          applyLeft = applyRR_2d;
          applyRight = applyRL_2d;
        }

        // ── 부품 왼쪽 경계 (yStart) ──
        if (prevP && Math.abs(prevP.r - p.r) > 0.001) {
          // 단차 존재
          const smallR = Math.min(prevP.r, p.r);
          const bigR = Math.max(prevP.r, p.r);
          const stepUp = (p.r > prevP.r); // 이 부품이 더 큼

          const stepH_L = bigR - smallR;
          // R값을 단차 높이 이내로 clamp
          const rClampL = Math.min(rVal, stepH_L * 0.95);
          if (applyLeft && rClampL > 0.001) {
            // 오목(concave) 필렛 at step transition
            if (stepUp) {
              // 이전부품(작음)→이 부품(큼): 코너 = (p.r, p.yStart)
              // 오목 원호: center = (p.r - rClampL, yStart + rClampL)
              profile.push(new THREE.Vector2(p.r - rClampL, p.yStart));
              for (let s = 1; s <= FILLET_SEGS; s++) {
                const a = (Math.PI / 2) * (1 - s / FILLET_SEGS);
                profile.push(new THREE.Vector2(
                  (p.r - rClampL) + rClampL * Math.cos(a),
                  p.yStart + rClampL - rClampL * Math.sin(a)
                ));
              }
            } else {
              // 이전부품(큼)→이 부품(작음): 이전 부품의 오른쪽 R이 처리
              profile.push(new THREE.Vector2(prevP.r, p.yStart));
              profile.push(new THREE.Vector2(p.r, p.yStart));
            }
          } else {
            // R값 없음: 직각 단차
            profile.push(new THREE.Vector2(prevP.r, p.yStart));
            profile.push(new THREE.Vector2(p.r, p.yStart));
          }
        } else if (!prevP) {
          // 첫 부품: 내경에서 외경으로
          profile.push(new THREE.Vector2(p.r, p.yStart));
        }
        // else: 동일 반경, 연속

        // ── 부품 오른쪽 경계 (yEnd) ──
        const nextP = i < parts.length - 1 ? parts[i + 1] : null;

        if (nextP && Math.abs(p.r - nextP.r) > 0.001) {
          const stepDown = (nextP.r < p.r); // 다음이 더 작음

          // 다음 부품의 R값 정보 (오른쪽 경계의 R은 다음 부품의 왼쪽 R이기도 함)
          // 하지만 R값은 이 부품(p)의 fillet이 결정
          const stepH_R = Math.abs(p.r - nextP.r);
          const rClampR = Math.min(rVal, stepH_R * 0.95);
          if (applyRight && rClampR > 0.001) {
            if (stepDown) {
              // 이 부품(큼)→다음(작음): 코너 = (p.r, p.yEnd)
              // center = (p.r - rClampR, yEnd - rClampR)
              profile.push(new THREE.Vector2(p.r, p.yEnd - rClampR));
              for (let s = 1; s <= FILLET_SEGS; s++) {
                const a = (Math.PI / 2) * (s / FILLET_SEGS);
                profile.push(new THREE.Vector2(
                  (p.r - rClampR) + rClampR * Math.cos(a),
                  (p.yEnd - rClampR) + rClampR * Math.sin(a)
                ));
              }
              profile.push(new THREE.Vector2(nextP.r, p.yEnd));
            } else {
              // 이 부품(작음)→다음(큼): 다음 부품의 왼쪽 R이 처리
              profile.push(new THREE.Vector2(p.r, p.yEnd));
            }
          } else {
            // R값 없음: 직선으로 yEnd까지
            profile.push(new THREE.Vector2(p.r, p.yEnd));
          }
        } else if (!nextP) {
          // 마지막 부품
          profile.push(new THREE.Vector2(p.r, p.yEnd));
        } else {
          // 동일 반경: 연속 (아무것도 추가 안 함)
        }
      }

      // 프로파일 닫기: 마지막 부품 외경 → 내경
      profile.push(new THREE.Vector2(boreR, assemblyYEnd));

      // LatheGeometry로 회전체 생성
      const bodyGeo = new THREE.LatheGeometry(profile, SEGMENTS_RADIAL);
      const bodyMesh = new THREE.Mesh(bodyGeo, spMat.clone());
      group.add(bodyMesh);

      // ── B. 보어 내벽 (BackSide, 시각적 깊이감) ──
      {
        const bLen = assemblyYEnd - assemblyYStart;
        const bCtr = (assemblyYStart + assemblyYEnd) / 2;
        const boreGeo = new THREE.CylinderGeometry(
          boreR * 0.99, boreR * 0.99, bLen + 0.02, SEGMENTS_RADIAL, 1, true
        );
        const bm = new THREE.Mesh(boreGeo, boreMat.clone());
        bm.position.set(0, bCtr, 0);
        group.add(bm);

        // 양쪽 끝 고리형 뚜껑 (bore 구멍 표시)
        const capL = new THREE.RingGeometry(boreR, parts[0].r, SEGMENTS_RADIAL);
        const cmL = new THREE.Mesh(capL, capMat.clone());
        cmL.rotation.x = Math.PI / 2;
        cmL.position.y = assemblyYStart;
        group.add(cmL);

        const lastP = parts[parts.length - 1];
        const capR = new THREE.RingGeometry(boreR, lastP.r, SEGMENTS_RADIAL);
        const cmR = new THREE.Mesh(capR, capMat.clone());
        cmR.rotation.x = -Math.PI / 2;
        cmR.position.y = assemblyYEnd;
        group.add(cmR);
      }

      // ── C. 톱니: rootR → gearOuterR, 기어 Y범위에만 ──
      // Shape은 XY평면 (group 회전 전 좌표계에서 XZ에 해당)
      // ExtrudeGeometry: +Z로 extrude (depth=gearW)
      // 문제: group.rotation.x=-PI/2이 적용되므로, tMesh에 rotation을 주면 이중회전.
      // 해결: ExtrudeGeometry 생성 후 position attribute를 직접 변환하여
      //       extrude 방향을 +Y(shaft축)로 전환.
      //   원본 vertex: (sx, sy, z) where z∈[0,gearW]
      //   변환 후: (sx, z + gearYStart, sy)
      //   → group.rotation.x=-PI/2 후: (sx, -sy, z+gearYStart) → shaft축=z ✓
      {
        const nTeeth = cg.teeth || 9;
        const aStep = (2 * Math.PI) / nTeeth;
        for (let t = 0; t < nTeeth; t++) {
          const ang = aStep * t;
          const tipH = aStep * 0.125, rootHf = aStep * 0.225;
          const rx1 = rootR * Math.cos(ang - rootHf), rz1 = rootR * Math.sin(ang - rootHf);
          const tx1 = gearOuterR * Math.cos(ang - tipH), tz1 = gearOuterR * Math.sin(ang - tipH);
          const tx2 = gearOuterR * Math.cos(ang + tipH), tz2 = gearOuterR * Math.sin(ang + tipH);
          const rx2 = rootR * Math.cos(ang + rootHf), rz2 = rootR * Math.sin(ang + rootHf);

          const sh = new THREE.Shape();
          sh.moveTo(rx1, rz1); sh.lineTo(tx1, tz1);
          sh.lineTo(tx2, tz2); sh.lineTo(rx2, rz2); sh.closePath();

          const tGeo = new THREE.ExtrudeGeometry(sh, { depth: gearW, bevelEnabled: false });

          // position attribute 직접 변환: Y↔Z swap + Y offset
          // 원본: (sx, sy, z) → 변환: (sx, z + gearYStart, sy)
          const posAttr = tGeo.attributes.position;
          for (let vi = 0; vi < posAttr.count; vi++) {
            const sx = posAttr.getX(vi);
            const sy = posAttr.getY(vi);
            const sz = posAttr.getZ(vi); // extrude depth, 0~gearW
            posAttr.setXYZ(vi, sx, sz + gearYStart, sy);
          }
          // normal도 동일하게 Y↔Z swap (방향 보정)
          const nrmAttr = tGeo.attributes.normal;
          if (nrmAttr) {
            for (let vi = 0; vi < nrmAttr.count; vi++) {
              const nx = nrmAttr.getX(vi);
              const ny = nrmAttr.getY(vi);
              const nz = nrmAttr.getZ(vi);
              nrmAttr.setXYZ(vi, nx, nz, ny);
            }
          }
          posAttr.needsUpdate = true;
          if (nrmAttr) nrmAttr.needsUpdate = true;
          tGeo.computeBoundingBox();
          tGeo.computeBoundingSphere();

          const tMesh = new THREE.Mesh(tGeo, spMat.clone());
          // rotation/position 불필요: vertex를 직접 변환했으므로 group rotation만 적용됨
          group.add(tMesh);
        }
      }
    });

    // ★ v173: 깊은 홈 볼베어링 3D — LatheGeometry 회전체 + 8개 볼
    //
    // 구현 방식:
    //   1. 2D 단면도(ai-engine.js 참조)의 외륜·내륜 프로파일을 LatheGeometry로 360° 회전
    //   2. 볼 8개를 45° 간격으로 배치 (SphereGeometry)
    //   3. 볼이 레이스 홈(race groove) 밖으로 돌출되지 않도록 CSG intersect 클리핑
    //
    // 좌표계 (group.rotation.x=-PI/2 적용 전):
    //   Y축 = shaft 축 방향, XZ평면 = 반지름 방향
    //   LatheGeometry: x=반지름, y=축방향(Y)

    const bearingFeatures = (hiddenFeatures || []).filter(hf => hf.type === 'bearing');

    if (bearingFeatures.length > 0) {
      // 베어링 재질 — 크롬 느낌의 밝은 금속
      const bearingOuterMat = new THREE.MeshStandardMaterial({
        color: 0xb0b8c4, metalness: 0.35, roughness: 0.45, flatShading: false,
      });
      const bearingInnerMat = new THREE.MeshStandardMaterial({
        color: 0xc0c8d0, metalness: 0.35, roughness: 0.45, flatShading: false,
      });
      const bearingBallMat = new THREE.MeshStandardMaterial({
        color: 0xd8dce5, metalness: 0.6, roughness: 0.2, flatShading: false,
      });
      const bearingBoreMat = new THREE.MeshStandardMaterial({
        color: 0x111118, metalness: 0.0, roughness: 1.0, side: THREE.BackSide,
      });
      const bearingCapMat = new THREE.MeshStandardMaterial({
        color: 0xb0b8c4, metalness: 0.35, roughness: 0.45, side: THREE.DoubleSide,
      });

      const BALL_COUNT = 12;
      const BALL_SEGMENTS = 32;
      const BEARING_LATHE_SEGS = 64;

      bearingFeatures.forEach((hf) => {
        // ── 치수 결정 (mm) — KS 규격표 재조회 ──
        let brB = hf.bearingWidth;
        let brD = hf.bearingOuter;
        let brd = hf.bearingBore;
        let brR = hf.bearingFillet || 0;

        if (hf.bearingDesignation && typeof DrawingModel !== 'undefined' && DrawingModel.lookupBearingByDesignation) {
          const ks = DrawingModel.lookupBearingByDesignation(String(hf.bearingDesignation).trim());
          if (ks && ks.found) {
            if (ks.D > 0) brD = ks.D;
            if (ks.d > 0) brd = ks.d;
            if (ks.B > 0) brB = ks.B;
            if (ks.r > 0) brR = ks.r;
          }
        }

        if (!(brD > brd) || !(brB > 0) || !(brD > 0) || !(brd > 0)) return;

        console.log(`[Preview3D] BEARING ${hf.id}: desig=${hf.bearingDesignation}, D=${brD}, d=${brd}, B=${brB}, r=${brR}`);

        // ── 3D 스케일 변환 (mm → 3D 유닛) ──
        const outerR = (brD / 2) * scale;    // 외경 반지름
        const boreR = (brd / 2) * scale;     // 내경 반지름
        const halfW = (brB / 2) * scale;     // 폭의 절반
        const filR = Math.min((brR || 0.5) * scale, halfW / 4, (outerR - boreR) / 4);

        // ── 볼 크기 계산 (2D ai-engine.js 공식 그대로) ──
        const ringBand = outerR - boreR;
        const ballDia3d = Math.max(0.01, Math.min(ringBand * (4 / 3), ringBand * 0.92, halfW * 2 * 0.92)) * 0.72;
        const ballR3d = ballDia3d / 2;

        // 볼 중심 반지름 (외경과 내경의 중간)
        const ballCenterR = (outerR + boreR) / 2;

        // ── 레이스 홈 어깨 위치 (2D와 동일 공식) ──
        const SHOULDER_F = 0.72;
        const shoulderOff = ballR3d * SHOULDER_F;    // 어깨선의 볼 중심 대비 반지름 오프셋
        const outerInnerR = ballCenterR + shoulderOff;   // 외륜 안쪽면 (홈 바닥) 반지름
        const innerOuterR = ballCenterR - shoulderOff;   // 내륜 바깥면 (홈 바닥) 반지름

        // ── Y축 위치 (축 방향) ──
        const sec = sections.find(s => s.id === hf.section);
        if (!sec) return;
        const secInfo = sectionYMap[sec.id];
        if (!secInfo) return;

        const sectionLenMm = sec.length || 1;
        const brLeftOff = hf.bearingLeftOffset;
        const brRightOff = hf.bearingRightOffset;

        let bearingYCenter;
        if (brLeftOff != null && !isNaN(brLeftOff)) {
          bearingYCenter = secInfo.yStart + (brLeftOff + brB / 2) * scale;
        } else if (brRightOff != null && !isNaN(brRightOff)) {
          bearingYCenter = secInfo.yEnd - (brRightOff + brB / 2) * scale;
        } else {
          bearingYCenter = (secInfo.yStart + secInfo.yEnd) / 2;
        }

        const yMin = bearingYCenter - halfW;
        const yMax = bearingYCenter + halfW;

        // ── 홈 곡면 파라미터 ──
        // 볼이 들어가는 홈(race groove)은 볼 반지름과 같은 곡률의 원호형 홈
        // 홈 단면: 볼 중심에서 어깨까지의 원호 (반지름 = ballR3d)
        const grooveR = ballR3d * 1.04;  // 홈 곡률 반지름 (볼보다 약간 큼)
        const grooveHalfAngle = Math.asin(Math.min(1, shoulderOff / grooveR));

        // ── A. 외륜 (Outer Ring) — LatheGeometry ──
        // 단면 프로파일 (x=반지름, y=축방향):
        //   외면(outerR, yMin) → 필렛 → 외면(outerR, yMax) → 필렛
        //   → 안쪽면(홈 어깨) → 홈 곡선 → 안쪽면 → 닫힘
        {
          const profile = [];
          const FSEGS = 8;

          // 왼쪽 하단: 안쪽(홈 어깨)에서 시작
          profile.push(new THREE.Vector2(outerInnerR, yMin));

          // 왼쪽 변: 위로 올라감 (안쪽면 → 외면)
          if (filR > 0.001) {
            // 내경→외경 코너 필렛 (yMin 쪽)
            profile.push(new THREE.Vector2(outerR - filR, yMin));
            for (let i = 1; i <= FSEGS; i++) {
              const a = Math.PI / 2 * (1 - i / FSEGS);
              profile.push(new THREE.Vector2(
                outerR - filR + filR * Math.sin(a),
                yMin + filR - filR * Math.cos(a)
              ));
            }
          } else {
            profile.push(new THREE.Vector2(outerR, yMin));
          }

          // 외면 상부
          if (filR > 0.001) {
            profile.push(new THREE.Vector2(outerR, yMax - filR));
            for (let i = 1; i <= FSEGS; i++) {
              const a = Math.PI / 2 * (i / FSEGS);
              profile.push(new THREE.Vector2(
                outerR - filR + filR * Math.cos(a),
                yMax - filR + filR * Math.sin(a)
              ));
            }
          } else {
            profile.push(new THREE.Vector2(outerR, yMax));
          }

          // 오른쪽: 외면 → 안쪽면(홈 어깨)으로 내려옴
          profile.push(new THREE.Vector2(outerInnerR, yMax));

          // 안쪽면: 오른쪽 어깨 → 홈 곡선(오목) → 왼쪽 어깨
          // 홈 곡선: 볼 자리를 감싸는 오목한 원호
          const grooveCenterY = bearingYCenter;
          const GROOVE_SEGS = 16;
          for (let i = 0; i <= GROOVE_SEGS; i++) {
            const t = i / GROOVE_SEGS;
            // 오른쪽 어깨(+shoulderOff)에서 왼쪽 어깨(-shoulderOff)로
            const angRange = grooveHalfAngle * 2;
            const ang = grooveHalfAngle - angRange * t;
            const gy = grooveCenterY + grooveR * Math.sin(ang);
            const gr = ballCenterR + grooveR * Math.cos(ang);
            // 외륜 홈: 안쪽이 오목 → 반지름이 ballCenterR 쪽으로 줄어듦
            profile.push(new THREE.Vector2(gr, gy));
          }

          const outerRingGeo = new THREE.LatheGeometry(profile, BEARING_LATHE_SEGS);
          const outerRingMesh = new THREE.Mesh(outerRingGeo, bearingOuterMat.clone());
          group.add(outerRingMesh);

          // 외륜 양쪽 끝 뚜껑 (고리형)
          const capGeoL = new THREE.RingGeometry(outerInnerR, outerR, BEARING_LATHE_SEGS);
          const capML = new THREE.Mesh(capGeoL, bearingCapMat.clone());
          capML.rotation.x = Math.PI / 2;
          capML.position.y = yMin;
          group.add(capML);

          const capGeoR = new THREE.RingGeometry(outerInnerR, outerR, BEARING_LATHE_SEGS);
          const capMR = new THREE.Mesh(capGeoR, bearingCapMat.clone());
          capMR.rotation.x = -Math.PI / 2;
          capMR.position.y = yMax;
          group.add(capMR);
        }

        // ── B. 내륜 (Inner Ring) — LatheGeometry ──
        {
          const profile = [];
          const FSEGS = 8;

          // 왼쪽 하단: 내면(bore)에서 시작
          if (filR > 0.001) {
            profile.push(new THREE.Vector2(boreR + filR, yMin));
            for (let i = 1; i <= FSEGS; i++) {
              const a = Math.PI / 2 * (i / FSEGS);
              profile.push(new THREE.Vector2(
                boreR + filR - filR * Math.cos(a),
                yMin + filR - filR * Math.sin(a)
              ));
            }
          } else {
            profile.push(new THREE.Vector2(boreR, yMin));
          }

          // 내면(bore): 아래→위
          if (filR > 0.001) {
            profile.push(new THREE.Vector2(boreR, yMax - filR));
            for (let i = 1; i <= FSEGS; i++) {
              const a = Math.PI / 2 * (1 - i / FSEGS);
              profile.push(new THREE.Vector2(
                boreR + filR - filR * Math.sin(a),
                yMax - filR + filR * Math.cos(a)
              ));
            }
          } else {
            profile.push(new THREE.Vector2(boreR, yMax));
          }

          // 오른쪽: 내면(bore) → 바깥면(홈 어깨)으로 올라감
          profile.push(new THREE.Vector2(innerOuterR, yMax));

          // 바깥면: 오른쪽 어깨 → 홈 곡선(오목) → 왼쪽 어깨
          const grooveCenterY = bearingYCenter;
          const GROOVE_SEGS = 16;
          for (let i = 0; i <= GROOVE_SEGS; i++) {
            const t = i / GROOVE_SEGS;
            const angRange = grooveHalfAngle * 2;
            const ang = grooveHalfAngle - angRange * t;
            const gy = grooveCenterY + grooveR * Math.sin(ang);
            const gr = ballCenterR - grooveR * Math.cos(ang);
            // 내륜 홈: 바깥이 오목 → 반지름이 ballCenterR 쪽으로 늘어남
            profile.push(new THREE.Vector2(gr, gy));
          }

          const innerRingGeo = new THREE.LatheGeometry(profile, BEARING_LATHE_SEGS);
          const innerRingMesh = new THREE.Mesh(innerRingGeo, bearingInnerMat.clone());
          group.add(innerRingMesh);

          // 내륜 bore 내벽 (BackSide, 시각적 깊이감)
          const bLen = yMax - yMin;
          const bCtr = bearingYCenter;
          const boreGeo = new THREE.CylinderGeometry(
            boreR * 0.99, boreR * 0.99, bLen + 0.02, BEARING_LATHE_SEGS, 1, true
          );
          const bm = new THREE.Mesh(boreGeo, bearingBoreMat.clone());
          bm.position.set(0, bCtr, 0);
          group.add(bm);

          // 내륜 양쪽 끝 뚜껑 (고리형)
          const capGeoL = new THREE.RingGeometry(boreR, innerOuterR, BEARING_LATHE_SEGS);
          const capML = new THREE.Mesh(capGeoL, bearingCapMat.clone());
          capML.rotation.x = Math.PI / 2;
          capML.position.y = yMin;
          group.add(capML);

          const capGeoR = new THREE.RingGeometry(boreR, innerOuterR, BEARING_LATHE_SEGS);
          const capMR = new THREE.Mesh(capGeoR, bearingCapMat.clone());
          capMR.rotation.x = -Math.PI / 2;
          capMR.position.y = yMax;
          group.add(capMR);
        }

        // ── C. 볼 8개 — 45° 간격 배치 + CSG 클리핑 ──
        // 볼이 레이스 홈 밖으로 돌출되지 않도록:
        //   방법: 클리핑 토러스(torus) = 홈 안쪽 공간 → CSG intersect
        //   또는 간단히: 볼 반지름을 shoulderOff로 제한하여 시각적으로 홈에 묻히게
        //
        // ★ 사용자 요구: "볼의 상하 조인트 외부로 볼이 보여선 안된다"
        //   → 볼을 CSG intersect로 클리핑하여 어깨선 밖으로 돌출 방지
        //   클리핑 볼륨: 어깨 사이의 원환(torus-like ring)
        {
          const useCSGClip = (typeof CSG !== 'undefined');

          for (let i = 0; i < BALL_COUNT; i++) {
            const angle = (2 * Math.PI / BALL_COUNT) * i;
            const bx = ballCenterR * Math.cos(angle);
            const bz = ballCenterR * Math.sin(angle);
            const by = bearingYCenter;

            if (useCSGClip) {
              // CSG 클리핑: 볼 ∩ 클리핑 실린더
              // 클리핑 볼륨: 반지름 outerInnerR ~ innerOuterR 사이, 
              //              축방향 어깨 범위(shoulderOff*2) 내의 공간
              // 대신 더 간단한 방법: 구를 생성 후 외륜/내륜 홈 표면 밖의 부분을 잘라냄
              // → 가장 심플한 방법: 구를 생성하고 바깥쪽/안쪽 실린더로 subtract
              try {
                const ballGeo = new THREE.SphereGeometry(ballR3d, BALL_SEGMENTS, BALL_SEGMENTS);
                const ballMesh = new THREE.Mesh(ballGeo, bearingBallMat);
                ballMesh.position.set(bx, by, bz);
                ballMesh.updateMatrix();
                let ballCSG = CSG.fromMesh(ballMesh);

                // 외측 클리핑: outerInnerR 바깥 부분 제거
                // 클리핑 실린더 (볼보다 충분히 큰 축방향 길이)
                const clipH = ballR3d * 3;
                const outerClipGeo = new THREE.CylinderGeometry(
                  outerR * 2, outerR * 2, clipH, BALL_SEGMENTS, 1, false
                );
                const outerClipMesh = new THREE.Mesh(outerClipGeo, bearingBallMat);
                outerClipMesh.position.set(0, by, 0);
                outerClipMesh.updateMatrix();

                const innerClipGeo = new THREE.CylinderGeometry(
                  outerInnerR, outerInnerR, clipH, BALL_SEGMENTS, 1, false
                );
                const innerClipMesh = new THREE.Mesh(innerClipGeo, bearingBallMat);
                innerClipMesh.position.set(0, by, 0);
                innerClipMesh.updateMatrix();

                // 외측 링 = 큰 실린더 - outerInnerR 실린더 → 외륜 바깥 부분
                const outerRingCSG = CSG.fromMesh(outerClipMesh).subtract(CSG.fromMesh(innerClipMesh));
                // 볼에서 외륜 바깥 부분 제거
                ballCSG = ballCSG.subtract(outerRingCSG);

                outerClipGeo.dispose();
                innerClipGeo.dispose();

                // 내측 클리핑: innerOuterR 안쪽 부분 제거
                const innerCoreGeo = new THREE.CylinderGeometry(
                  innerOuterR, innerOuterR, clipH, BALL_SEGMENTS, 1, false
                );
                const innerCoreMesh = new THREE.Mesh(innerCoreGeo, bearingBallMat);
                innerCoreMesh.position.set(0, by, 0);
                innerCoreMesh.updateMatrix();
                const innerCoreCSG = CSG.fromMesh(innerCoreMesh);
                // 볼에서 내륜 안쪽 부분 제거
                ballCSG = ballCSG.subtract(innerCoreCSG);

                innerCoreGeo.dispose();

                // 축방향 클리핑: 어깨선(yMin~yMax) 밖으로 돌출 방지
                // 위쪽 잘라내기 (y > yMax 부분)
                const topClipGeo = new THREE.BoxGeometry(outerR * 4, ballR3d * 2, outerR * 4);
                const topClipMesh = new THREE.Mesh(topClipGeo, bearingBallMat);
                topClipMesh.position.set(0, yMax + ballR3d, 0);
                topClipMesh.updateMatrix();
                ballCSG = ballCSG.subtract(CSG.fromMesh(topClipMesh));
                topClipGeo.dispose();

                // 아래쪽 잘라내기 (y < yMin 부분)
                const botClipGeo = new THREE.BoxGeometry(outerR * 4, ballR3d * 2, outerR * 4);
                const botClipMesh = new THREE.Mesh(botClipGeo, bearingBallMat);
                botClipMesh.position.set(0, yMin - ballR3d, 0);
                botClipMesh.updateMatrix();
                ballCSG = ballCSG.subtract(CSG.fromMesh(botClipMesh));
                botClipGeo.dispose();

                // CSG 결과 → 메시
                const identity = new THREE.Matrix4();
                const clippedBall = CSG.toMesh(ballCSG, identity, bearingBallMat.clone());
                group.add(clippedBall);

                ballGeo.dispose();
              } catch (e) {
                console.warn(`[Preview3D] BEARING ball CSG clip failed for ball ${i}:`, e);
                // fallback: 클리핑 없이 구 추가
                const fbGeo = new THREE.SphereGeometry(shoulderOff * 0.95, BALL_SEGMENTS, BALL_SEGMENTS);
                const fbMesh = new THREE.Mesh(fbGeo, bearingBallMat.clone());
                fbMesh.position.set(bx, by, bz);
                group.add(fbMesh);
              }
            } else {
              // CSG 미지원: 볼 크기를 어깨 오프셋으로 제한 (돌출 최소화)
              const safeR = Math.min(ballR3d, shoulderOff * 0.95);
              const ballGeo = new THREE.SphereGeometry(safeR, BALL_SEGMENTS, BALL_SEGMENTS);
              const ballMesh = new THREE.Mesh(ballGeo, bearingBallMat.clone());
              ballMesh.position.set(bx, by, bz);
              group.add(ballMesh);
            }
          }
        }

        console.log(`[Preview3D] BEARING ${hf.id}: 3D 생성 완료 (outerR=${outerR.toFixed(3)}, boreR=${boreR.toFixed(3)}, balls=${BALL_COUNT})`);
      });
    }

    // 그룹 전체를 90° 회전하여 shaft 축 = Z축
    group.rotation.x = -Math.PI / 2;

    _mesh = group;
    _mesh._isSolidShaft = true;
    _scene.add(_mesh);

    // 그리드 크기 조정
    _scene.remove(_gridHelper);
    const gridSize = Math.max(totalScaledLen, maxDiam * scale) * 2;
    _gridHelper = new THREE.GridHelper(gridSize, 40, 0x2a2d3e, 0x2a2d3e);
    _gridHelper.position.y = -(maxDiam / 2) * scale - 0.3;
    _scene.add(_gridHelper);

    // 카메라 거리 조정
    _cameraDistance = Math.max(totalScaledLen, maxDiam * scale) * 1.5;
    _targetDistance = _cameraDistance;
  }

  /** 카메라를 정면도(front view)로 설정: shaft 축 정면 → -Z 방향 */
  function _setCameraFrontView() {
    // 정면도: 카메라가 shaft 축 앞에서 바라봄 (축 = Z, 카메라 = +Z 방향)
    _rotation = { x: 0, y: 0 };
    _targetRotation = { x: 0, y: 0 };
    _updateCamera();
  }

  function _setView(view) {
    switch (view) {
      case 'front':
        _targetRotation = { x: 0, y: 0 };
        break;
      case 'side':
        _targetRotation = { x: 0, y: Math.PI / 2 };
        break;
      case 'top':
        _targetRotation = { x: Math.PI / 2 - 0.001, y: 0 };
        break;
      case 'iso':
        _targetRotation = { x: Math.PI / 6, y: Math.PI / 4 };
        break;
    }
    // 버튼 활성화 표시
    document.querySelectorAll('.prev3d-btn').forEach(b => b.classList.remove('active'));
    const btnMap = { front: 'btn3dFront', side: 'btn3dSide', top: 'btn3dTop', iso: 'btn3dIso' };
    const btn = document.getElementById(btnMap[view]);
    if (btn) btn.classList.add('active');
  }

  function _toggleWireframe() {
    if (!_mesh) return;
    // Group인 경우 children 순회, 단일 Mesh인 경우 직접 접근
    let isWire = false;
    _mesh.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.wireframe = !child.material.wireframe;
        isWire = child.material.wireframe;
      }
    });
    const btn = document.getElementById('btn3dWire');
    if (btn) btn.classList.toggle('active', isWire);
  }

  /** 카메라 위치 업데이트 (구면 좌표) */
  function _updateCamera() {
    const phi = _rotation.x;    // 상하 (elevation)
    const theta = _rotation.y;  // 좌우 (azimuth)
    const d = _cameraDistance;

    _camera.position.x = d * Math.cos(phi) * Math.sin(theta);
    _camera.position.y = d * Math.sin(phi);
    _camera.position.z = d * Math.cos(phi) * Math.cos(theta);

    _camera.lookAt(0, 0, 0);
  }

  // ── 마우스 이벤트 ──
  function _onMouseDown(e) {
    if (e.button !== 0) return;
    _isDragging = true;
    _prevMouse = { x: e.clientX, y: e.clientY };
    _container.style.cursor = 'grabbing';
  }

  function _onMouseMove(e) {
    if (!_isDragging) return;
    const dx = e.clientX - _prevMouse.x;
    const dy = e.clientY - _prevMouse.y;
    _prevMouse = { x: e.clientX, y: e.clientY };

    _targetRotation.y += dx * ROTATE_SPEED;
    _targetRotation.x += dy * ROTATE_SPEED;

    // 상하 제한 (-89° ~ 89°)
    const limit = Math.PI / 2 - 0.01;
    _targetRotation.x = Math.max(-limit, Math.min(limit, _targetRotation.x));
  }

  function _onMouseUp() {
    _isDragging = false;
    if (_container) _container.style.cursor = 'grab';
  }

  function _onWheel(e) {
    e.preventDefault();
    _targetDistance += e.deltaY * ZOOM_SPEED * _targetDistance;
    _targetDistance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, _targetDistance));
  }

  /** 애니메이션 루프 */
  function _animate() {
    _animFrameId = requestAnimationFrame(_animate);

    // Smooth interpolation
    _rotation.x += (_targetRotation.x - _rotation.x) * LERP_FACTOR;
    _rotation.y += (_targetRotation.y - _rotation.y) * LERP_FACTOR;
    _cameraDistance += (_targetDistance - _cameraDistance) * LERP_FACTOR;

    _updateCamera();
    _renderer.render(_scene, _camera);
  }

  /** 3D 미리보기 닫기 */
  function close() {
    // 애니메이션 중지
    if (_animFrameId) {
      cancelAnimationFrame(_animFrameId);
      _animFrameId = null;
    }

    // 이벤트 해제
    if (_container) {
      _container.removeEventListener('mousedown', _onMouseDown);
      _container.removeEventListener('mousemove', _onMouseMove);
      _container.removeEventListener('mouseup', _onMouseUp);
      _container.removeEventListener('mouseleave', _onMouseUp);
      _container.removeEventListener('wheel', _onWheel);
      if (_container._onResize) {
        window.removeEventListener('resize', _container._onResize);
      }
    }

    // Three.js 리소스 해제 (Group일 수 있으므로 children 순회)
    if (_mesh) {
      _mesh.traverse((child) => {
        if (child.isMesh) {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        }
      });
      if (_mesh.geometry) _mesh.geometry.dispose();
      if (_mesh.material) _mesh.material.dispose();
      _scene.remove(_mesh);
      _mesh = null;
    }
    if (_renderer) {
      _renderer.dispose();
      _renderer = null;
    }
    _scene = null;
    _camera = null;

    // 모달 제거 + 키보드 이벤트 해제
    const modal = document.getElementById('preview3dModal');
    if (modal) {
      if (modal._onKey) document.removeEventListener('keydown', modal._onKey);
      modal.remove();
    }
    _container = null;
  }

  return { open, close };
})();

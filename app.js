import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

const canvas = document.getElementById('canvas');
const viewer = document.getElementById('viewer');
const input = document.getElementById('modelInput');
const dropZone = document.getElementById('dropZone');
const loading = document.getElementById('loading');
const errorToast = document.getElementById('errorToast');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0d12');

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
camera.position.set(3, 2, 5);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 0.01;
controls.maxDistance = 10000;

const grid = new THREE.GridHelper(20, 20, 0x555d6f, 0x2b3140);
scene.add(grid);
const axes = new THREE.AxesHelper(1.5);
axes.visible = false;
scene.add(axes);

const hemi = new THREE.HemisphereLight(0xffffff, 0x232836, 1.2);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(4, 6, 4);
key.castShadow = true;
scene.add(key);
const fill = new THREE.DirectionalLight(0x9eb4ff, 0.9);
fill.position.set(-4, 2, -3);
scene.add(fill);

let modelRoot = null;
let mixer = null;
let clips = [];
let currentAction = null;
let isPlaying = false;
let modelFileName = '';
let loadedObjectURLs = [];

const clock = new THREE.Clock();

function resize() {
  const rect = viewer.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}
new ResizeObserver(resize).observe(viewer);
resize();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer && isPlaying) mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
}
animate();

function setBusy(busy) {
  loading.classList.toggle('hidden', !busy);
}

function showError(message) {
  errorToast.textContent = message;
  errorToast.classList.remove('hidden');
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => errorToast.classList.add('hidden'), 6000);
}

function cleanupModel() {
  if (modelRoot) {
    scene.remove(modelRoot);
    modelRoot.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
          Object.values(mat).forEach((value) => {
            if (value?.isTexture) value.dispose?.();
          });
          mat.dispose?.();
        });
      }
    });
  }
  modelRoot = null;
  mixer = null;
  clips = [];
  currentAction = null;
  isPlaying = false;
  loadedObjectURLs.forEach(URL.revokeObjectURL);
  loadedObjectURLs = [];
}

function addModel(root, animations = [], name = 'Model') {
  cleanupModel();
  modelRoot = root;
  modelFileName = name;
  scene.add(modelRoot);

  modelRoot.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (obj.material?.map) obj.material.map.colorSpace = THREE.SRGBColorSpace;
    }
  });

  clips = animations || [];
  if (clips.length) mixer = new THREE.AnimationMixer(modelRoot);

  dropZone.classList.add('hidden');
  updateStats();
  setupAnimationUI();
  frameModel();
  document.getElementById('fitBtn').disabled = false;
  document.getElementById('screenshotBtn').disabled = false;
}

function frameModel() {
  if (!modelRoot) return;
  const box = new THREE.Box3().setFromObject(modelRoot);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fov = camera.fov * Math.PI / 180;
  let distance = maxDim / (2 * Math.tan(fov / 2));
  distance *= 1.55;

  const direction = new THREE.Vector3(1, 0.65, 1).normalize();
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.near = Math.max(maxDim / 1000, 0.001);
  camera.far = Math.max(maxDim * 1000, 1000);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();

  grid.position.y = box.min.y;
  const gridScale = Math.max(maxDim / 10, 0.1);
  grid.scale.setScalar(gridScale);
  axes.scale.setScalar(Math.max(maxDim / 2, 0.1));
}

function updateStats() {
  if (!modelRoot) return;
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  const materials = new Set();

  modelRoot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    meshes++;
    const geom = obj.geometry;
    const pos = geom.getAttribute('position');
    if (pos) vertices += pos.count;
    triangles += geom.index ? geom.index.count / 3 : (pos ? pos.count / 3 : 0);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.filter(Boolean).forEach((m) => materials.add(m.uuid));
  });

  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = box.getSize(new THREE.Vector3());
  const fmt = (n) => new Intl.NumberFormat().format(Math.round(n));
  const fmtSize = (v) => `${v.x.toFixed(2)} × ${v.y.toFixed(2)} × ${v.z.toFixed(2)}`;

  document.getElementById('statName').textContent = modelFileName;
  document.getElementById('statMeshes').textContent = fmt(meshes);
  document.getElementById('statVertices').textContent = fmt(vertices);
  document.getElementById('statTriangles').textContent = fmt(triangles);
  document.getElementById('statMaterials').textContent = fmt(materials.size);
  document.getElementById('statAnimations').textContent = fmt(clips.length);
  document.getElementById('statSize').textContent = fmtSize(size);
}

function setupAnimationUI() {
  const select = document.getElementById('animationSelect');
  const play = document.getElementById('playPauseBtn');
  const stop = document.getElementById('stopBtn');
  const speed = document.getElementById('speedRange');

  select.innerHTML = '';
  if (!clips.length) {
    select.innerHTML = '<option>No animations</option>';
    select.disabled = true;
    play.disabled = true;
    stop.disabled = true;
    speed.disabled = true;
    play.textContent = 'Play';
    return;
  }

  clips.forEach((clip, i) => {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = clip.name || `Animation ${i + 1}`;
    select.appendChild(option);
  });
  select.disabled = false;
  play.disabled = false;
  stop.disabled = false;
  speed.disabled = false;
  play.textContent = 'Play';
  selectAnimation(0, false);
}

function selectAnimation(index, autoplay = true) {
  if (!mixer || !clips[index]) return;
  currentAction?.stop();
  currentAction = mixer.clipAction(clips[index]);
  currentAction.reset();
  if (autoplay) {
    currentAction.play();
    isPlaying = true;
    document.getElementById('playPauseBtn').textContent = 'Pause';
  } else {
    isPlaying = false;
    document.getElementById('playPauseBtn').textContent = 'Play';
  }
}

async function loadFiles(fileList) {
  const files = [...fileList];
  const model = files.find(f => /\.(glb|gltf)$/i.test(f.name)) || files.find(f => /\.obj$/i.test(f.name));
  if (!model) {
    showError('Choose a .glb, .gltf or .obj model file.');
    return;
  }

  setBusy(true);
  try {
    if (/\.(glb|gltf)$/i.test(model.name)) await loadGLTF(model, files);
    else await loadOBJ(model, files);
  } catch (err) {
    console.error(err);
    showError(`Could not load model: ${err.message || err}`);
  } finally {
    setBusy(false);
  }
}

async function loadGLTF(model, files) {
  const manager = new THREE.LoadingManager();
  const urlMap = new Map();
  for (const file of files) {
    const url = URL.createObjectURL(file);
    loadedObjectURLs.push(url);
    urlMap.set(file.name, url);
    urlMap.set(file.webkitRelativePath || file.name, url);
  }

  manager.setURLModifier((url) => {
    const clean = decodeURIComponent(url.split('/').pop());
    return urlMap.get(url) || urlMap.get(clean) || url;
  });

  const loader = new GLTFLoader(manager);
  const modelUrl = urlMap.get(model.name);
  const gltf = await loader.loadAsync(modelUrl);
  addModel(gltf.scene, gltf.animations, model.name);
}

async function loadOBJ(objFile, files) {
  const fileMap = new Map(files.map(f => [f.name, f]));
  let materials = null;
  const mtlFile = files.find(f => /\.mtl$/i.test(f.name));

  if (mtlFile) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const name = decodeURIComponent(url.split('/').pop());
      const file = fileMap.get(name);
      if (!file) return url;
      const objectUrl = URL.createObjectURL(file);
      loadedObjectURLs.push(objectUrl);
      return objectUrl;
    });
    const mtlText = await mtlFile.text();
    materials = new MTLLoader(manager).parse(mtlText, '');
    materials.preload();
  }

  const text = await objFile.text();
  const loader = new OBJLoader();
  if (materials) loader.setMaterials(materials);
  const object = loader.parse(text);
  addModel(object, [], objFile.name);
}

input.addEventListener('change', () => {
  if (input.files?.length) loadFiles(input.files);
  input.value = '';
});

['dragenter','dragover'].forEach(type => viewer.addEventListener(type, (e) => {
  e.preventDefault();
  dropZone.classList.add('dragging');
}));
['dragleave','drop'].forEach(type => viewer.addEventListener(type, (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
}));
viewer.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
});

document.getElementById('gridToggle').addEventListener('change', e => grid.visible = e.target.checked);
document.getElementById('axesToggle').addEventListener('change', e => axes.visible = e.target.checked);
document.getElementById('rotateToggle').addEventListener('change', e => controls.autoRotate = e.target.checked);
document.getElementById('wireframeToggle').addEventListener('change', e => {
  modelRoot?.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach(m => m.wireframe = e.target.checked);
  });
});

document.getElementById('keyLight').addEventListener('input', e => {
  key.intensity = Number(e.target.value);
  document.getElementById('keyLightValue').textContent = Number(e.target.value).toFixed(1);
});
document.getElementById('ambientLight').addEventListener('input', e => {
  hemi.intensity = Number(e.target.value);
  document.getElementById('ambientLightValue').textContent = Number(e.target.value).toFixed(1);
});

document.querySelectorAll('.swatch').forEach(btn => btn.addEventListener('click', () => {
  scene.background = new THREE.Color(btn.dataset.bg);
}));

document.getElementById('resetCameraBtn').addEventListener('click', () => {
  if (modelRoot) frameModel();
  else {
    camera.position.set(3, 2, 5);
    controls.target.set(0, 0, 0);
    controls.update();
  }
});
document.getElementById('fitBtn').addEventListener('click', frameModel);

document.getElementById('animationSelect').addEventListener('change', e => selectAnimation(Number(e.target.value), true));
document.getElementById('playPauseBtn').addEventListener('click', () => {
  if (!currentAction) selectAnimation(Number(document.getElementById('animationSelect').value), true);
  else if (isPlaying) {
    currentAction.paused = true;
    isPlaying = false;
    document.getElementById('playPauseBtn').textContent = 'Play';
  } else {
    currentAction.paused = false;
    currentAction.play();
    isPlaying = true;
    document.getElementById('playPauseBtn').textContent = 'Pause';
  }
});
document.getElementById('stopBtn').addEventListener('click', () => {
  if (!currentAction) return;
  currentAction.stop();
  currentAction.reset();
  isPlaying = false;
  document.getElementById('playPauseBtn').textContent = 'Play';
});
document.getElementById('speedRange').addEventListener('input', e => {
  const speed = Number(e.target.value);
  if (mixer) mixer.timeScale = speed;
  document.getElementById('speedValue').textContent = `${speed.toFixed(1)}×`;
});

document.getElementById('screenshotBtn').addEventListener('click', () => {
  renderer.render(scene, camera);
  const link = document.createElement('a');
  link.download = `${(modelFileName || 'model').replace(/\.[^.]+$/, '')}-screenshot.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
});

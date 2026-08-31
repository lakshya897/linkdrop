import { useEffect, useRef } from 'react';

export function CrystalBackground() {
  const shaderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const threeContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 1. Ambient WebGL Fragment Shader Background
    const canvas = shaderCanvasRef.current;
    if (!canvas) return;

    let animFrameId: number;
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const vs = `attribute vec2 a_position; varying vec2 v_texCoord; void main() { v_texCoord = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;
      const fs = `precision highp float; uniform float u_time; uniform vec2 u_resolution;
      void main() {
          vec2 uv = gl_FragCoord.xy / u_resolution.xy;
          vec3 color = vec3(0.035, 0.035, 0.043);
          float noise = sin(uv.x * 10.0 + u_time) * sin(uv.y * 10.0 + u_time) * 0.02;
          color += noise;
          float dist = distance(uv, vec2(1.0, 0.0));
          color += mix(vec3(0.1, 0.05, 0.2), vec3(0.0), smoothstep(0.0, 0.8, dist)) * 0.3;
          gl_FragColor = vec4(color, 1.0);
      }`;

      const compileShader = (type: number, src: string) => {
        const s = gl.createShader(type);
        if (!s) return null;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };

      const vertShader = compileShader(gl.VERTEX_SHADER, vs);
      const fragShader = compileShader(gl.FRAGMENT_SHADER, fs);
      if (vertShader && fragShader) {
        const prog = gl.createProgram();
        if (prog) {
          gl.attachShader(prog, vertShader);
          gl.attachShader(prog, fragShader);
          gl.linkProgram(prog);
          gl.useProgram(prog);

          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

          const pos = gl.getAttribLocation(prog, 'a_position');
          gl.enableVertexAttribArray(pos);
          gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

          const uTime = gl.getUniformLocation(prog, 'u_time');
          const uRes = gl.getUniformLocation(prog, 'u_resolution');

          const resize = () => {
            const w = canvas.clientWidth || window.innerWidth;
            const h = canvas.clientHeight || window.innerHeight;
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w;
              canvas.height = h;
            }
          };

          window.addEventListener('resize', resize);
          resize();

          let lastTime = 0;
          const fpsInterval = 1000 / 30; // Cap at 30 FPS to preserve CPU for P2P transfers

          const render = (t: number) => {
            if (document.hidden) {
              animFrameId = requestAnimationFrame(render);
              return;
            }
            const elapsed = t - lastTime;
            if (elapsed > fpsInterval) {
              lastTime = t - (elapsed % fpsInterval);
              gl.viewport(0, 0, canvas.width, canvas.height);
              if (uTime) gl.uniform1f(uTime, t * 0.001);
              if (uRes) gl.uniform2f(uRes, canvas.width, canvas.height);
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            animFrameId = requestAnimationFrame(render);
          };
          render(0);
        }
      }
    }

    return () => {
      if (animFrameId) cancelAnimationFrame(animFrameId);
    };
  }, []);

  useEffect(() => {
    // 2. Three.js 3D Geometric Crystal Companion
    const container = threeContainerRef.current;
    if (!container || typeof window.THREE === 'undefined') return;

    const THREE = window.THREE;
    let animId: number;

    const scene = new THREE.Scene();
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 600;

    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(1);
    container.appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0x8B5CF6, 2, 20);
    pointLight.position.set(5, 5, 5);
    scene.add(pointLight);

    const pinkLight = new THREE.PointLight(0xF472B6, 1.5, 20);
    pinkLight.position.set(-5, -5, 2);
    scene.add(pinkLight);

    // Crystal Core
    const crystalGeo = new THREE.IcosahedronGeometry(1.5, 0);
    const crystalMat = new THREE.MeshPhysicalMaterial({
      color: 0x8B5CF6,
      metalness: 0.9,
      roughness: 0.1,
      transmission: 0.5,
      thickness: 1,
      clearcoat: 1,
      emissive: 0x8B5CF6,
      emissiveIntensity: 0.2
    });
    const crystal = new THREE.Mesh(crystalGeo, crystalMat);
    scene.add(crystal);

    // Wireframe Shell
    const wireframeGeo = new THREE.IcosahedronGeometry(1.7, 0);
    const wireframeMat = new THREE.MeshBasicMaterial({
      color: 0xF472B6,
      wireframe: true,
      transparent: true,
      opacity: 0.25
    });
    const shell = new THREE.Mesh(wireframeGeo, wireframeMat);
    scene.add(shell);

    // Particles / Data Bits
    const particlesCount = 40;
    const particlesGeo = new THREE.BufferGeometry();
    const posArray = new Float32Array(particlesCount * 3);
    for (let i = 0; i < particlesCount * 3; i++) {
      posArray[i] = (Math.random() - 0.5) * 6;
    }
    particlesGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    const particlesMat = new THREE.PointsMaterial({ size: 0.05, color: 0xffffff, transparent: true, opacity: 0.4 });
    const particles = new THREE.Points(particlesGeo, particlesMat);
    scene.add(particles);

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || 600;
      const h = container.clientHeight || 600;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    let scrollY = 0;
    const handleScroll = () => {
      scrollY = window.scrollY;
    };
    window.addEventListener('scroll', handleScroll);

    let lastThreeTime = 0;
    const threeFpsInterval = 1000 / 30;

    const animate = (t: number) => {
      animId = requestAnimationFrame(animate);
      if (document.hidden) return;

      const elapsed = t - lastThreeTime;
      if (elapsed > threeFpsInterval) {
        lastThreeTime = t - (elapsed % threeFpsInterval);
        const targetRotation = scrollY * 0.002;
        crystal.rotation.y += 0.005 + targetRotation * 0.1;
        crystal.rotation.x = targetRotation;

        shell.rotation.y -= 0.003;
        shell.rotation.z = targetRotation * 0.5;

        particles.rotation.y += 0.001;

        const time = Date.now() * 0.001;
        crystal.position.y = Math.sin(time) * 0.1;

        renderer.render(scene, camera);
      }
    };
    animate(0);

    return () => {
      if (animId) cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <>
      {/* Ambient Background Shader Canvas */}
      <div className="fixed inset-0 z-[-2] pointer-events-none w-full h-full bg-[#09090B]">
        <canvas ref={shaderCanvasRef} className="block w-full h-full" />
      </div>

      {/* 3D Crystal Companion */}
      <div className="fixed top-24 right-0 w-full lg:w-1/2 h-[450px] lg:h-[650px] z-0 pointer-events-none flex items-center justify-center opacity-70 mix-blend-screen transition-opacity duration-300">
        <div ref={threeContainerRef} className="w-full h-full pointer-events-none" />
      </div>
    </>
  );
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    THREE?: any;
  }
}

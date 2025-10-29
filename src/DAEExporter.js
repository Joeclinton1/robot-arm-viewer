import * as THREE from 'three';

// DAE (Collada) Exporter for URDF robots
// Exports the current state of the robot to Collada format with materials
export class DAEExporter {
    constructor() {
        this.materials = new Map();
        this.geometries = new Map();
    }

    parse(object) {
        this.materials.clear();
        this.geometries.clear();

        // Collect all meshes (excluding collision meshes)
        const meshes = [];
        object.traverse(child => {
            if (child.isMesh && child.geometry && child.visible) {
                // Check parent chain for collision
                let parent = child.parent;
                let isCollision = false;
                while (parent) {
                    if (parent.isURDFCollider || (parent.name && parent.name.includes('_collision'))) {
                        isCollision = true;
                        break;
                    }
                    parent = parent.parent;
                }

                if (isCollision) {
                    return;
                }

                meshes.push(child);

                // Handle both single material and material arrays
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(mat => {
                            if (mat) this.materials.set(mat.uuid, mat);
                        });
                    } else {
                        this.materials.set(child.material.uuid, child.material);
                    }
                }
                if (child.geometry) {
                    this.geometries.set(child.geometry.uuid, child.geometry);
                }
            }
        });

        // Build Collada XML
        let output = '<?xml version="1.0" encoding="UTF-8"?>\n';
        output += '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">\n';

        // Asset
        output += '  <asset>\n';
        output += `    <created>${new Date().toISOString()}</created>\n`;
        output += `    <modified>${new Date().toISOString()}</modified>\n`;
        output += '    <up_axis>Y_UP</up_axis>\n';
        output += '  </asset>\n';

        // Library effects (material shaders)
        output += this.buildLibraryEffects();

        // Library materials
        output += this.buildLibraryMaterials();

        // Library geometries
        output += this.buildLibraryGeometries(meshes);

        // Library visual scenes
        output += this.buildLibraryVisualScenes(meshes);

        // Scene
        output += '  <scene>\n';
        output += '    <instance_visual_scene url="#Scene"/>\n';
        output += '  </scene>\n';

        output += '</COLLADA>';

        return output;
    }

    buildLibraryEffects() {
        let output = '  <library_effects>\n';

        for (const [uuid, material] of this.materials.entries()) {
            const effectId = `effect_${uuid}`;
            const color = material.color || new THREE.Color(0.8, 0.8, 0.8);

            output += `    <effect id="${effectId}">\n`;
            output += '      <profile_COMMON>\n';
            output += '        <technique sid="common">\n';
            output += '          <phong>\n';

            // Diffuse color
            output += '            <diffuse>\n';
            output += `              <color>${color.r} ${color.g} ${color.b} 1</color>\n`;
            output += '            </diffuse>\n';

            // Ambient
            output += '            <ambient>\n';
            output += `              <color>${color.r * 0.5} ${color.g * 0.5} ${color.b * 0.5} 1</color>\n`;
            output += '            </ambient>\n';

            // Specular based on roughness/metalness
            if (material.type === 'MeshStandardMaterial') {
                const roughness = material.roughness !== undefined ? material.roughness : 0.5;
                const metalness = material.metalness !== undefined ? material.metalness : 0.2;
                const specIntensity = (1.0 - roughness) * 0.5;

                output += '            <specular>\n';
                output += `              <color>${specIntensity} ${specIntensity} ${specIntensity} 1</color>\n`;
                output += '            </specular>\n';
                output += '            <shininess>\n';
                output += `              <float>${(1.0 - roughness) * 100}</float>\n`;
                output += '            </shininess>\n';
            } else {
                output += '            <specular>\n';
                output += '              <color>0.5 0.5 0.5 1</color>\n';
                output += '            </specular>\n';
                output += '            <shininess>\n';
                output += '              <float>50</float>\n';
                output += '            </shininess>\n';
            }

            output += '          </phong>\n';
            output += '        </technique>\n';
            output += '      </profile_COMMON>\n';
            output += '    </effect>\n';
        }

        output += '  </library_effects>\n';
        return output;
    }

    buildLibraryMaterials() {
        let output = '  <library_materials>\n';

        for (const [uuid, material] of this.materials.entries()) {
            const materialId = `material_${uuid}`;
            const effectId = `effect_${uuid}`;

            output += `    <material id="${materialId}">\n`;
            output += `      <instance_effect url="#${effectId}"/>\n`;
            output += '    </material>\n';
        }

        output += '  </library_materials>\n';
        return output;
    }

    buildLibraryGeometries(meshes) {
        let output = '  <library_geometries>\n';

        // Build a map of geometry to mesh for transform application
        const geomToMesh = new Map();
        meshes.forEach(mesh => {
            geomToMesh.set(mesh.geometry.uuid, mesh);
        });

        for (const [uuid, geometry] of this.geometries.entries()) {
            const mesh = geomToMesh.get(uuid);
            const geomId = `geometry_${uuid}`;
            output += `    <geometry id="${geomId}">\n`;
            output += `      <mesh>\n`;

            // Clone and transform geometry
            const geo = geometry.clone();
            if (mesh) {
                mesh.updateMatrixWorld();
                geo.applyMatrix4(mesh.matrixWorld);
            }

            // Compute normals if needed
            if (!geo.attributes.normal) {
                geo.computeVertexNormals();
            }

            // Positions
            const positions = geo.attributes.position;
            if (positions) {
                const posId = `${geomId}_positions`;
                output += `        <source id="${posId}">\n`;
                output += `          <float_array id="${posId}_array" count="${positions.count * 3}">\n`;
                output += '            ';
                for (let i = 0; i < positions.count; i++) {
                    output += `${positions.getX(i)} ${positions.getY(i)} ${positions.getZ(i)} `;
                }
                output += '\n';
                output += '          </float_array>\n';
                output += '          <technique_common>\n';
                output += `            <accessor source="#${posId}_array" count="${positions.count}" stride="3">\n`;
                output += '              <param name="X" type="float"/>\n';
                output += '              <param name="Y" type="float"/>\n';
                output += '              <param name="Z" type="float"/>\n';
                output += '            </accessor>\n';
                output += '          </technique_common>\n';
                output += '        </source>\n';
            }

            // Normals
            const normals = geo.attributes.normal;
            if (normals) {
                const normId = `${geomId}_normals`;
                output += `        <source id="${normId}">\n`;
                output += `          <float_array id="${normId}_array" count="${normals.count * 3}">\n`;
                output += '            ';
                for (let i = 0; i < normals.count; i++) {
                    output += `${normals.getX(i)} ${normals.getY(i)} ${normals.getZ(i)} `;
                }
                output += '\n';
                output += '          </float_array>\n';
                output += '          <technique_common>\n';
                output += `            <accessor source="#${normId}_array" count="${normals.count}" stride="3">\n`;
                output += '              <param name="X" type="float"/>\n';
                output += '              <param name="Y" type="float"/>\n';
                output += '              <param name="Z" type="float"/>\n';
                output += '            </accessor>\n';
                output += '          </technique_common>\n';
                output += '        </source>\n';
            }

            geo.dispose();

            // Vertices
            const posId = `${geomId}_positions`;
            const vertId = `${geomId}_vertices`;
            output += `        <vertices id="${vertId}">\n`;
            output += `          <input semantic="POSITION" source="#${posId}"/>\n`;
            output += '        </vertices>\n';

            // Triangles - handle geometry groups for multi-material meshes
            const indices = geo.index;
            const indexCount = indices ? indices.count : positions.count;
            const groups = geo.groups && geo.groups.length > 0 ? geo.groups : [{ start: 0, count: indexCount, materialIndex: 0 }];

            groups.forEach((group, groupIndex) => {
                const triCount = group.count / 3;
                const materialSymbol = `material_${groupIndex}`;

                output += `        <triangles material="${materialSymbol}" count="${triCount}">\n`;
                output += `          <input semantic="VERTEX" source="#${vertId}" offset="0"/>\n`;
                if (normals) {
                    const normId = `${geomId}_normals`;
                    output += `          <input semantic="NORMAL" source="#${normId}" offset="0"/>\n`;
                }
                output += '          <p>';

                if (indices) {
                    for (let i = group.start; i < group.start + group.count; i++) {
                        output += `${indices.getX(i)} `;
                    }
                } else {
                    for (let i = group.start; i < group.start + group.count; i++) {
                        output += `${i} `;
                    }
                }
                output += '</p>\n';
                output += '        </triangles>\n';
            });

            output += '      </mesh>\n';
            output += '    </geometry>\n';
        }

        output += '  </library_geometries>\n';
        return output;
    }

    buildLibraryVisualScenes(meshes) {
        let output = '  <library_visual_scenes>\n';
        output += '    <visual_scene id="Scene">\n';

        meshes.forEach((mesh, index) => {
            const nodeId = `node_${index}`;
            const geomId = `geometry_${mesh.geometry.uuid}`;

            // Use identity matrix since transforms are baked into geometry
            output += `      <node id="${nodeId}">\n`;
            output += '        <matrix>';
            output += '1 0 0 0 ';
            output += '0 1 0 0 ';
            output += '0 0 1 0 ';
            output += '0 0 0 1';
            output += '</matrix>\n';
            output += '        <instance_geometry url="#' + geomId + '">\n';
            output += '          <bind_material>\n';
            output += '            <technique_common>\n';

            // Handle both single material and material arrays
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const groups = mesh.geometry.groups && mesh.geometry.groups.length > 0
                ? mesh.geometry.groups
                : [{ materialIndex: 0 }];

            groups.forEach((group, groupIndex) => {
                const materialIndex = group.materialIndex !== undefined ? group.materialIndex : 0;
                const material = materials[materialIndex];
                const materialId = material ? `material_${material.uuid}` : 'default';
                const materialSymbol = `material_${groupIndex}`;

                output += `              <instance_material symbol="${materialSymbol}" target="#${materialId}"/>\n`;
            });

            output += '            </technique_common>\n';
            output += '          </bind_material>\n';
            output += '        </instance_geometry>\n';
            output += '      </node>\n';
        });

        output += '    </visual_scene>\n';
        output += '  </library_visual_scenes>\n';
        return output;
    }

    // Helper function to download the DAE file
    static download(content, filename = 'robot.dae') {
        const blob = new Blob([content], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }
}

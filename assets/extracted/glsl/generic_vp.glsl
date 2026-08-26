#version 120
/*
 * generic_vp.glsl
 * generic quake 3 shader rendering vertex program
 * Copyright (C) 2010  Jens Loehr <jens.loehr@gmx.de>
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
 * Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 */

/* pi */
#define M_PI 3.14159265358979323846

/* alphaGen_t */
#define AGEN_IDENTITY 0
#define AGEN_SKIP 1
#define AGEN_ENTITY 2
#define AGEN_ONE_MINUS_ENTITY 3
#define AGEN_VERTEX 4
#define AGEN_ONE_MINUS_VERTEX 5
#define AGEN_LIGHTING_SPECULAR 6
#define AGEN_WAVEFORM 7
#define AGEN_PORTAL 8
#define AGEN_CONST 9

/* colorGen_t */
#define CGEN_BAD 0
#define CGEN_IDENTITY_LIGHTING 1
#define CGEN_IDENTITY 2
#define CGEN_ENTITY 3
#define CGEN_ONE_MINUS_ENTITY 4
#define CGEN_EXACT_VERTEX 5
#define CGEN_VERTEX 6
#define CGEN_ONE_MINUS_VERTEX 7
#define CGEN_WAVEFORM 8
#define CGEN_LIGHTING_DIFFUSE 9
#define CGEN_LIGHTING_UNIFORM 10
#define CGEN_LIGHTING_DYNAMIC 11
#define CGEN_FOG 12
#define CGEN_CONST 13

/* texCoordGen_t */
#define TCGEN_LIGHTMAP 2

/* uniform variables */
uniform float u_IdentityLight;
uniform int u_AlphaGen;
uniform int u_ColorGen;
uniform int u_Greyscale;
uniform int u_TCGen0;
uniform int u_TCGen1;
uniform int u_TexEnv;
uniform vec3 u_AmbientLight;
uniform vec3 u_DirectedLight;
uniform vec3 u_DynamicLight;
uniform float u_LightDistance;
uniform vec3 u_LightDirection;
uniform vec4 u_ConstantColor;
uniform vec4 u_FogColor;
uniform vec4 u_EntityColor;

/*
 * DeformGeometry
 * Deform geometry (deformVertexes)
 */
vec4 DeformGeometry(vec4 position) {
	// STUB
	return position;
}

/*
 * CalcDiffuseColor
 * Calculate Diffuse Color
 */
vec4 CalcDiffuseColor(vec4 color) {
	float incoming;
	
	incoming = dot(gl_Normal, u_LightDirection);
	
	if (incoming <= 0.0) {
		color.r = u_AmbientLight.r;
		color.g = u_AmbientLight.g;
		color.b = u_AmbientLight.b;
	} else {
		float x;
		
		x = u_AmbientLight.r + incoming * u_DirectedLight.r;
		if (x > 1.0)
			x = 1.0;
		
		color.r = x;
		
		x = u_AmbientLight.g + incoming * u_DirectedLight.g;
		if (x > 1.0)
			x = 1.0;
		
		color.g = x;
		
		x = u_AmbientLight.b + incoming * u_DirectedLight.b;
		if (x > 1.0)
			x = 1.0;
		
		color.b = x;
	}
	
	color.a = 1.0;
	
	return color;
}

/*
 * CalcUniformColor
 * Calculate Uniform Color
 */
vec4 CalcUniformColor(vec4 color) {
	float x;
		
	x = u_AmbientLight.r + u_AmbientLight.r;
	if (x > 1.0)
		x = 1.0;
	
	color.r = x;
		
	x = u_AmbientLight.g + u_AmbientLight.g;
	if (x > 1.0)
		x = 1.0;
	
	color.g = x;
		
	x = u_AmbientLight.b + u_AmbientLight.b;
	if (x > 1.0)
		x = 1.0;
		
	color.b = x;
	
	color.a = 1.0;
	
	return color;
}

/*
 * CalcDynamicColor
 * Calculate Dynamic Color
 */
vec4 CalcDynamicColor(vec4 color) {
	float x;
		
	x = u_DynamicLight.r;
	if (x > 1.0)
		x = 1.0;
	
	color.r = x;
		
	x = u_DynamicLight.g;
	if (x > 1.0)
		x = 1.0;
	
	color.g = x;
		
	x = u_DynamicLight.b;
	if (x > 1.0)
		x = 1.0;
		
	color.b = x;
	
	color.a = 1.0;
	
	return color;
}

/*
 * CalcWaveColor
 * Calculate Wave Color
 */
vec4 CalcWaveColor(vec4 color) {
	// STUB
	return color;
}

/*
 * ComputeColor
 * Compute color
 */
vec4 ComputeColor(vec4 color) {
	/* u_ColorGen */
	if (u_ColorGen == CGEN_IDENTITY) {
		color.r = 1.0;
		color.g = 1.0;
		color.b = 1.0;
		color.a = 1.0;
	} else if (u_ColorGen == CGEN_IDENTITY_LIGHTING) {
		color.r = u_IdentityLight;
		color.g = u_IdentityLight;
		color.b = u_IdentityLight;
		color.a = u_IdentityLight;
	} else if (u_ColorGen == CGEN_LIGHTING_DIFFUSE) {
		color = CalcDiffuseColor(color);
	} else if (u_ColorGen == CGEN_LIGHTING_UNIFORM) {
		color = CalcUniformColor(color);
	} else if (u_ColorGen == CGEN_LIGHTING_DYNAMIC) {
		color = CalcDynamicColor(color);
	} else if (u_ColorGen == CGEN_EXACT_VERTEX) {
		/*
		 * color.r = color.r;
		 * color.g = color.g;
		 * color.b = color.b;
		 * color.a = color.a;
		 */
	} else if (u_ColorGen == CGEN_CONST) {
		color.r = u_ConstantColor.r;
		color.g = u_ConstantColor.g;
		color.b = u_ConstantColor.b;
		color.a = u_ConstantColor.a;
	} else if (u_ColorGen == CGEN_VERTEX) {
		if (u_IdentityLight == 1.0) {
			/*
			 * color.r = color.r;
			 * color.g = color.g;
			 * color.b = color.b;
			 * color.a = color.a;
			 */
		} else {
			color.r = color.r * u_IdentityLight;
			color.g = color.g * u_IdentityLight;
			color.b = color.b * u_IdentityLight;
			/* color.a = color.a; */
		}
	} else if (u_ColorGen == CGEN_ONE_MINUS_VERTEX) {
		if (u_IdentityLight == 1.0) {
			color.r = 1.0 - color.r;
			color.g = 1.0 - color.g;
			color.b = 1.0 - color.g;
			/* color.a = color.a; */
		} else {
			color.r = (1.0 - color.r) * u_IdentityLight;
			color.g = (1.0 - color.g) * u_IdentityLight;
			color.b = (1.0 - color.b) * u_IdentityLight;
			/* color.a = color.a; */
		}
	} else if (u_ColorGen == CGEN_FOG) {
		color.r = u_FogColor.r;
		color.g = u_FogColor.g;
		color.b = u_FogColor.b;
		color.a = u_FogColor.a;
	} else if (u_ColorGen == CGEN_WAVEFORM) {
		color = CalcWaveColor(color);
	} else if (u_ColorGen == CGEN_ENTITY) {
		color.r = u_EntityColor.r;
		color.g = u_EntityColor.g;
		color.b = u_EntityColor.b;
		color.a = u_EntityColor.a;
	} else if (u_ColorGen == CGEN_ONE_MINUS_ENTITY) {
		color.r = 1.0 - u_EntityColor.r;
		color.g = 1.0 - u_EntityColor.g;
		color.b = 1.0 - u_EntityColor.b;
		color.a = 1.0 - u_EntityColor.a;
	}
	
	/* alpha stuff */

	/* fog stuff */
	
	/* if in greyscale rendering mode turn all color values into greyscale */
	if (bool(u_Greyscale)) {
		float scale;
		
		scale = (color.r + color.g + color.b) / 3.0;
		color.r = scale;
		color.g = scale;
		color.b = scale;
	}

	return color;
}

/*
 * ComputeTexCoords
 * Compute texture coordinates
 */
vec4 ComputeTexCoords(vec4 texCoord0, vec4 texCoord1, int tcGen) {
	vec4 texCoord;
	
	if (tcGen == TCGEN_LIGHTMAP) {
		texCoord = texCoord1;
	} else {
		texCoord = texCoord0;
	}
	
	return texCoord;
}

/*
 * main
 * Entry point for generic vertex program
 */
void main(void) {
	vec4 color;
	
	/* vertex position */
	gl_Position = DeformGeometry(ftransform());
	
	/* vertex color */
	color = ComputeColor(gl_Color);
	gl_FrontColor = color;
	gl_BackColor = color;
	
	/* texture coordinates */
	gl_TexCoord[0] = ComputeTexCoords(gl_MultiTexCoord0, gl_MultiTexCoord1, u_TCGen0);
	
	/* multi-texturing */
	if (u_TexEnv > -1) {
		gl_TexCoord[1] = ComputeTexCoords(gl_MultiTexCoord0, gl_MultiTexCoord1, u_TCGen1);
	}
}

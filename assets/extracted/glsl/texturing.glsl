#version 120
/*
 * texturing.glsl
 * shared texturing routines
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

/* multi-texturing modes */
#define REPLACE		0
#define MODULATE	1
#define DECAL		2
#define BLEND		3
#define ADD			4
#define COMBINE		5

vec4 applyTexture2D(sampler2D textureUnit, int type, int index, vec4 color) {
	vec4 texture = texture2D(textureUnit, gl_TexCoord[index].st);
	
	if (type == REPLACE) {
		color		= texture;
	} else if (type == MODULATE) {
		color		*= texture;
	} else if (type == DECAL) {
		color		= vec4(mix(color.rgb, texture.rgb, texture.a), color.a);
	} else if (type == BLEND) {
		color		= vec4(mix(color.rgb, gl_TextureEnvColor[index].rgb, texture.rgb), color.a * texture.a);
	} else if (type == ADD) {
		color.rgb	+= texture.rgb;
		color.a		*= texture.a;
		
		color		= clamp(color, 0.0, 1.0);
	} else {
		color		= clamp(texture * color, 0.0, 1.0);
	}
	
	return color;
}
